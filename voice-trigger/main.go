// voice-trigger is a standalone test program: it runs pocketsphinx_continuous
// in keyword-spotting mode against the microphone and runs a shell command
// (default: a short libcamera-vid capture) whenever the keyphrase is spotted.
// It has no dependency on the rest of the hard-hat agent — it's meant for
// bench-testing mic + wake-phrase + camera on the Raspberry Pi before wiring
// this into the real edge agent.
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
	kwsFile := flag.String("kws_file", "keyword.list", "PocketSphinx keyword-spotting list file (KEYPHRASE /THRESHOLD/ per line)")
	sphinxBin := flag.String("pocketsphinx_bin", "pocketsphinx_continuous", "Path to the pocketsphinx_continuous binary")
	hmm := flag.String("hmm", "", "Optional path to an acoustic model directory (default: pocketsphinx's built-in en-us model)")
	dict := flag.String("dict", "", "Optional path to a pronunciation dictionary")
	cameraCmd := flag.String("camera_cmd", "libcamera-vid -t 10000 -o /home/pi/clip.h264", "Shell command to run when the keyphrase is spotted")
	cooldown := flag.Duration("cooldown", 3*time.Second, "Minimum time between triggers, to ignore repeat detections from the same utterance")
	flag.Parse()

	if _, err := os.Stat(*kwsFile); err != nil {
		log.Fatalf("keyword list file %q not found: %v", *kwsFile, err)
	}

	args := []string{"-inmic", "yes", "-kws", *kwsFile}
	if *hmm != "" {
		args = append(args, "-hmm", *hmm)
	}
	if *dict != "" {
		args = append(args, "-dict", *dict)
	}

	cmd := exec.Command(*sphinxBin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Fatalf("failed to attach stdout pipe: %v", err)
	}
	cmd.Stderr = os.Stderr // pocketsphinx's own logging; useful for debugging mic/model issues

	if err := cmd.Start(); err != nil {
		log.Fatalf("failed to start %s: %v (is pocketsphinx installed and on PATH?)", *sphinxBin, err)
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
		triggerCamera(*cameraCmd)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("stdout scan error: %v", err)
	}

	_ = cmd.Wait()
}

func triggerCamera(cmdline string) {
	parts := strings.Fields(cmdline)
	if len(parts) == 0 {
		log.Println("camera_cmd is empty, nothing to run")
		return
	}

	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		log.Printf("failed to start camera command: %v", err)
		return
	}

	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("camera command exited with error: %v", err)
			return
		}
		log.Println("camera command finished")
	}()
}
