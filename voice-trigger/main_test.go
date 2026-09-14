package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func helper(t *testing.T, name, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func waitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("command did not produce %s", path)
}

func TestActionsAreDistinct(t *testing.T) {
	for input, want := range map[string]string{
		"turn on camera": "camera_on", "turn off camera": "camera_off",
		" OFF camera ": "camera_off", "camera": "camera_on",
		"turn on light": "light_on", "turn off light": "light_off", "unknown": "",
	} {
		if got := actionFor(input); got != want {
			t.Fatalf("%q: %q != %q", input, got, want)
		}
	}
}

func TestSingleWaitAndRepeatedStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "started")
	command := helper(t, "capture", "touch "+path+"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n")
	runner := &cameraRunner{}
	if !runner.trigger(command) {
		t.Fatal("first trigger rejected")
	}
	waitFile(t, path)
	if runner.trigger(command) {
		t.Fatal("repeated trigger started second camera")
	}
	runner.stop()
	runner.stop()
	if !runner.trigger(command) {
		t.Fatal("camera could not restart after graceful stop")
	}
	runner.stop()
}

func TestLightDoesNotStartCameraAndStopIgnoresStartCooldown(t *testing.T) {
	dir := t.TempDir()
	cameraPath, lightPath := filepath.Join(dir, "camera"), filepath.Join(dir, "light")
	d := dispatcher{
		cameraCmd:  helper(t, "camera", "touch "+cameraPath+"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n"),
		lightOnCmd: helper(t, "light", "touch "+lightPath+"\n"),
		cooldown:   time.Hour, last: make(map[string]time.Time), camera: &cameraRunner{}, light: &cameraRunner{},
	}
	now := time.Now()
	d.handle("turn on light", now)
	waitFile(t, lightPath)
	if _, err := os.Stat(cameraPath); !os.IsNotExist(err) {
		t.Fatal("light started the camera")
	}
	d.handle("turn on camera", now)
	waitFile(t, cameraPath)
	d.handle("turn off camera", now.Add(time.Millisecond))
	d.camera.mu.Lock()
	active := d.camera.cmd != nil
	d.camera.mu.Unlock()
	if active {
		t.Fatal("camera off was swallowed by debounce")
	}
	d.light.stop()
}
