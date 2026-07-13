package main

import (
	"strconv"
	"strings"
)

// Pure parsers for the /proc files the agent reads. Kept string-in so they are
// unit-testable on any OS (the syscall-backed collectors live in collect.go).

// parseMeminfo returns total and available bytes from /proc/meminfo (kB → bytes).
func parseMeminfo(content string) (total, available uint64) {
	for _, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		kb, _ := strconv.ParseUint(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			total = kb * 1024
		case "MemAvailable:":
			available = kb * 1024
		}
	}
	return total, available
}

// parseLoadavg returns the 1-minute load average from /proc/loadavg.
func parseLoadavg(content string) float64 {
	f := strings.Fields(content)
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

// parseUptime returns uptime seconds from /proc/uptime.
func parseUptime(content string) float64 {
	f := strings.Fields(content)
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

// parseStat returns aggregate idle and total jiffies from the "cpu " line of
// /proc/stat. CPU usage is derived from the delta between two samples.
func parseStat(content string) (idle, total uint64) {
	for _, line := range strings.Split(content, "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		for i, tok := range strings.Fields(line)[1:] {
			v, _ := strconv.ParseUint(tok, 10, 64)
			total += v
			if i == 3 || i == 4 { // idle + iowait
				idle += v
			}
		}
		break
	}
	return idle, total
}

// cpuUsagePercent derives CPU % from two /proc/stat samples.
func cpuUsagePercent(idle1, total1, idle2, total2 uint64) float64 {
	dTotal := float64(total2) - float64(total1)
	dIdle := float64(idle2) - float64(idle1)
	if dTotal <= 0 {
		return 0
	}
	usage := (1 - dIdle/dTotal) * 100
	if usage < 0 {
		return 0
	}
	return round2(usage)
}

// parseNetDev sums rx/tx bytes across all non-loopback interfaces of /proc/net/dev.
func parseNetDev(content string) (rx, tx uint64) {
	for _, line := range strings.Split(content, "\n") {
		idx := strings.IndexByte(line, ':')
		if idx < 0 {
			continue
		}
		iface := strings.TrimSpace(line[:idx])
		if iface == "lo" || iface == "" {
			continue
		}
		f := strings.Fields(line[idx+1:])
		if len(f) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(f[0], 10, 64)
		t, _ := strconv.ParseUint(f[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}

func pct(used, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return round2(float64(used) / float64(total) * 100)
}
