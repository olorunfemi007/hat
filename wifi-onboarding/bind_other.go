//go:build !linux

package main

import "syscall"

// bindToDeviceControl is a no-op outside Linux (SO_BINDTODEVICE is a
// Linux-specific socket option). This project only ever runs for real on
// the Pi (always Linux, see bind_linux.go for the actual implementation) -
// this file exists purely so local development/testing builds still work
// on macOS.
func bindToDeviceControl(iface string) func(network, address string, c syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		return nil
	}
}
