//go:build linux

package main

import "syscall"

// bindToDeviceControl returns a net.Dialer.Control function that binds the
// dialed socket to iface at the kernel level (SO_BINDTODEVICE), forcing all
// traffic for that connection out that specific interface regardless of
// what the routing table would otherwise choose. Setting only the source IP
// (Dialer.LocalAddr) isn't enough when another interface also has a route
// to the destination - the kernel can pick that other interface for egress
// while still carrying the wlan0-owned source IP, producing packets that
// get silently dropped (reverse-path filtering) or never receive a routable
// reply, hanging until timeout instead of failing fast.
func bindToDeviceControl(iface string) func(network, address string, c syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		var sockErr error
		if err := c.Control(func(fd uintptr) {
			sockErr = syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, iface)
		}); err != nil {
			return err
		}
		return sockErr
	}
}
