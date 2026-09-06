// voice-trigger is a standalone test program: it runs a keyword-spotting
// subprocess (default: kws_listen.py, a pocketsphinx LiveSpeech wrapper)
// against the microphone, and runs a shell command (default: a short
// libcamera-vid capture) each time it prints a spotted line. It has no
// dependency on the rest of the hard-hat agent — it's meant for bench-testing
// mic + wake-phrase + camera on the Raspberry Pi before wiring this into the
// real edge agent.
//
// The listener backend is intentionally just a command line (-listen_cmd),
// not something main.go knows the flags of — that keeps this program working
// no matter which STT engine or CLI ends up available on a given OS image.
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
	cameraCmd := flag.String("camera_cmd", "libcamera-vid -t 10000 -o /home/pi/clip.h264", "Shell command to run when the keyphrase is spotted")
	cooldown := flag.Duration("cooldown", 3*time.Second, "Minimum time between triggers, to ignore repeat detections from the same utterance")
	flag.Parse()

	cmd, err := startCommand(*listenCmd)
	if err != nil {
		log.Fatalf("failed to start listen_cmd %q: %v", *listenCmd, err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Fatalf("failed to attach stdout pipe: %v", err)
	}
	cmd.Stderr = os.Stderr // the listener's own logging; useful for debugging mic/model issues

	if err := cmd.Start(); err != nil {
		log.Fatalf("failed to start %q: %v", *listenCmd, err)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("shutting down")
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}()

	log.Println("listening for keyphrase (ctrl-C to quit)")

	var mu sync.Mutex
	var lastTrigger time.Time
	camera := &cameraRunner{}

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		log.Printf("spotted: %s", line)

		mu.Lock()
		ready := time.Since(lastTrigger) >= *cooldown
		if ready {
			lastTrigger = time.Now()
		}
		mu.Unlock()

		if !ready {
			continue
		}

		log.Println("keyphrase spotted -> triggering camera")
		camera.trigger(*cameraCmd)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("stdout scan error: %v", err)
	}

	_ = cmd.Wait()
}

// startCommand builds an *exec.Cmd from a space-separated command line
// without starting it yet, so the caller can wire up pipes first.
func startCommand(cmdline string) (*exec.Cmd, error) {
	parts := strings.Fields(cmdline)
	if len(parts) == 0 {
		return nil, os.ErrInvalid
	}
	return exec.Command(parts[0], parts[1:]...), nil
}

// cameraRunner ensures at most one camera_cmd process runs at a time. This
// matters for long-running commands (e.g. a --listen video stream that never
// exits on its own) — without it, a repeat keyphrase trigger would try to
// start a second instance and typically fail (e.g. "failed to bind listen
// socket" from a port already held by the first one).
type cameraRunner struct {
	mu  sync.Mutex
	cmd *exec.Cmd
}

func (c *cameraRunner) trigger(cmdline string) {
	parts := strings.Fields(cmdline)
	if len(parts) == 0 {
		log.Println("camera_cmd is empty, nothing to run")
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cmd != nil && c.cmd.Process != nil {
		log.Println("stopping previous camera command before starting a new one")
		_ = c.cmd.Process.Signal(syscall.SIGTERM)
		_ = c.cmd.Wait()
	}

	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		log.Printf("failed to start camera command: %v", err)
		return
	}
	c.cmd = cmd

	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("camera command exited with error: %v", err)
			return
		}
		log.Println("camera command finished")
	}()
}
