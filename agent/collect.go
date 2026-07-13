package main

import (
	"os"
	"strings"
	"syscall"
	"time"
)

type CPU struct {
	Cores        int     `json:"cores"`
	UsagePercent float64 `json:"usagePercent"`
	Load1        float64 `json:"load1"`
}

type Mem struct {
	TotalBytes     uint64  `json:"totalBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPercent    float64 `json:"usedPercent"`
}

type Disk struct {
	Mount       string  `json:"mount"`
	TotalBytes  uint64  `json:"totalBytes"`
	UsedBytes   uint64  `json:"usedBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

type Net struct {
	RxBytes uint64 `json:"rxBytes"`
	TxBytes uint64 `json:"txBytes"`
}

// Snapshot is the single JSON document the agent prints. Version tag `v` lets the
// consumer evolve the schema.
type Snapshot struct {
	V         int     `json:"v"`
	TS        string  `json:"ts"`
	Host      string  `json:"host"`
	UptimeSec float64 `json:"uptimeSec"`
	CPU       CPU     `json:"cpu"`
	Mem       Mem     `json:"mem"`
	Disks     []Disk  `json:"disks"`
	Net       Net     `json:"net"`
}

func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func collect() Snapshot {
	host, _ := os.Hostname()

	idle1, total1 := parseStat(readFile("/proc/stat"))
	time.Sleep(200 * time.Millisecond)
	idle2, total2 := parseStat(readFile("/proc/stat"))

	memTotal, memAvail := parseMeminfo(readFile("/proc/meminfo"))
	rx, tx := parseNetDev(readFile("/proc/net/dev"))

	return Snapshot{
		V:         1,
		TS:        time.Now().UTC().Format(time.RFC3339),
		Host:      host,
		UptimeSec: round2(parseUptime(readFile("/proc/uptime"))),
		CPU: CPU{
			Cores:        countCores(readFile("/proc/stat")),
			UsagePercent: cpuUsagePercent(idle1, total1, idle2, total2),
			Load1:        parseLoadavg(readFile("/proc/loadavg")),
		},
		Mem: Mem{
			TotalBytes:     memTotal,
			AvailableBytes: memAvail,
			UsedPercent:    pct(memTotal-memAvail, memTotal),
		},
		Disks: collectDisks(),
		Net:   Net{RxBytes: rx, TxBytes: tx},
	}
}

// countCores counts the per-core "cpuN" lines in /proc/stat.
func countCores(stat string) int {
	n := 0
	for _, line := range strings.Split(stat, "\n") {
		if len(line) > 3 && strings.HasPrefix(line, "cpu") && line[3] >= '0' && line[3] <= '9' {
			n++
		}
	}
	if n == 0 {
		return 1
	}
	return n
}

// collectDisks statfs-es every real (device-backed) mount from /proc/mounts.
func collectDisks() []Disk {
	disks := []Disk{}
	seen := map[string]bool{}
	for _, line := range strings.Split(readFile("/proc/mounts"), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || !strings.HasPrefix(f[0], "/") || seen[f[1]] {
			continue
		}
		// Skip file bind-mounts (e.g. Docker's /etc/hosts) — only real dir mounts.
		if fi, err := os.Stat(f[1]); err != nil || !fi.IsDir() {
			continue
		}
		seen[f[1]] = true
		var st syscall.Statfs_t
		if syscall.Statfs(f[1], &st) != nil {
			continue
		}
		bsize := uint64(st.Bsize)
		total := st.Blocks * bsize
		used := (st.Blocks - st.Bfree) * bsize
		disks = append(disks, Disk{Mount: f[1], TotalBytes: total, UsedBytes: used, UsedPercent: pct(used, total)})
	}
	return disks
}
