// voice-trigger dispatches recognized camera and optional light phrases to
// operator-configured commands. The default camera command finalizes and queues
// bounded recordings for the separate device sync service.
package main

import (
	"bufio"
	"flag"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

func main() {
	listenCmd := flag.String("listen_cmd", "python3 kws_listen.py", "Command whose stdout prints one line per spotted keyphrase")
	cameraCmd := flag.String("camera_cmd", "/usr/bin/python3 -B /opt/hardhat/device-agent/capture.py", "Camera command; default records a unique queued MP4 clip")
	lightOnCmd := flag.String("light_on_cmd", "", "Optional command for turn on light (no hardware defaults)")
	lightOffCmd := flag.String("light_off_cmd", "", "Optional command for turn off light (no hardware defaults)")
	cooldown := flag.Duration("cooldown", 3*time.Second, "Minimum time between repeated identical actions")
	flag.Parse()

	cmd, err := startCommand(*listenCmd)
	if err != nil {
		log.Fatalf("invalid listener command: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Fatalf("failed to attach listener output: %v", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Fatalf("failed to start listener: %v", err)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)
	finished := make(chan struct{})
	go func() {
		select {
		case <-sig:
			log.Println("shutting down")
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		case <-finished:
		}
	}()

	d := dispatcher{cameraCmd: *cameraCmd, lightOnCmd: *lightOnCmd, lightOffCmd: *lightOffCmd,
		cooldown: *cooldown, last: make(map[string]time.Time), camera: &cameraRunner{}, light: &cameraRunner{}}
	log.Println("listening for camera and configured light phrases")
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		d.handle(scanner.Text(), time.Now())
	}
	if err := scanner.Err(); err != nil {
		log.Printf("listener output error: %v", err)
	}
	d.camera.stop()
	d.light.stop()
	if err := cmd.Wait(); err != nil {
		log.Printf("listener exited: %v", err)
	}
	close(finished)
}

// Commands are argv separated by whitespace, as in the original runner. Use
// an executable wrapper script when arguments need embedded spaces or pipes.
func startCommand(cmdline string) (*exec.Cmd, error) {
	parts := strings.Fields(cmdline)
	if len(parts) == 0 {
		return nil, os.ErrInvalid
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd, nil
}

func actionFor(line string) string {
	switch strings.Join(strings.Fields(strings.ToLower(line)), " ") {
	case "camera", "on camera", "turn on camera", "start recording":
		return "camera_on"
	case "off camera", "turn off camera", "stop recording":
		return "camera_off"
	case "on light", "turn on light":
		return "light_on"
	case "off light", "turn off light":
		return "light_off"
	default:
		return ""
	}
}

type dispatcher struct {
	cameraCmd, lightOnCmd, lightOffCmd string
	cooldown                           time.Duration
	last                               map[string]time.Time
	camera, light                      *cameraRunner
}

func (d *dispatcher) handle(line string, now time.Time) {
	action := actionFor(line)
	if action == "" {
		return
	}
	// Separate actions are never debounced against each other: an immediate
	// 'turn off camera' must stop a recording, even inside the start cooldown.
	if last, ok := d.last[action]; ok && now.Sub(last) < d.cooldown {
		return
	}
	d.last[action] = now
	switch action {
	case "camera_on":
		d.camera.trigger(d.cameraCmd)
	case "camera_off":
		d.camera.stop()
	case "light_on":
		d.light.stop()
		d.light.trigger(d.lightOnCmd)
	case "light_off":
		d.light.stop()
		d.light.trigger(d.lightOffCmd)
	}
}

// One goroutine owns Wait for each process. Repeated camera-on phrases leave
// the current clip running; camera-off asks the wrapper to finalize it. This
// avoids the previous double-Wait race and truncated clips on repeated speech.
type cameraRunner struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	done chan struct{}
}

func (c *cameraRunner) trigger(cmdline string) bool {
	if strings.TrimSpace(cmdline) == "" {
		log.Println("action command is not configured")
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd != nil {
		log.Println("action is already running")
		return false
	}
	cmd, err := startCommand(cmdline)
	if err != nil {
		log.Printf("invalid action command: %v", err)
		return false
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("failed to start action: %v", err)
		return false
	}
	c.cmd = cmd
	done := make(chan struct{})
	c.done = done
	go func() {
		err := cmd.Wait()
		c.mu.Lock()
		if c.cmd == cmd {
			c.cmd = nil
		}
		close(done)
		c.mu.Unlock()
		if err != nil {
			log.Printf("action exited: %v", err)
		} else {
			log.Println("action finished")
		}
	}()
	return true
}

func (c *cameraRunner) stop() {
	c.mu.Lock()
	cmd, done := c.cmd, c.done
	if cmd != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	}
	c.mu.Unlock()
	if cmd == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(90 * time.Second):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
	}
}
