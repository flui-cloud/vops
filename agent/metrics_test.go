package main

import "testing"

func TestParseMeminfo(t *testing.T) {
	content := "MemTotal:        2048000 kB\nMemFree:          100000 kB\nMemAvailable:     512000 kB\n"
	total, avail := parseMeminfo(content)
	if total != 2048000*1024 || avail != 512000*1024 {
		t.Fatalf("got total=%d avail=%d", total, avail)
	}
}

func TestParseLoadavgAndUptime(t *testing.T) {
	if got := parseLoadavg("1.25 0.80 0.55 1/234 5678"); got != 1.25 {
		t.Fatalf("load1 = %v", got)
	}
	if got := parseUptime("123456.78 987654.32"); got != 123456.78 {
		t.Fatalf("uptime = %v", got)
	}
}

func TestParseStatAndCpuUsage(t *testing.T) {
	// idle = user+nice+system+idle+iowait... we sum idle+iowait as idle.
	s1 := "cpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0\n"
	s2 := "cpu  150 0 150 900 0 0 0 0\ncpu0 75 0 75 450 0\n"
	i1, t1 := parseStat(s1)
	i2, t2 := parseStat(s2)
	// idle 800→900 (Δ100), total 1000→1200 (Δ200) → usage = (1 - 100/200)*100 = 50
	if got := cpuUsagePercent(i1, t1, i2, t2); got < 49.9 || got > 50.1 {
		t.Fatalf("cpu usage = %v", got)
	}
	if c := countCores(s1); c != 1 {
		t.Fatalf("cores = %d", c)
	}
}

func TestParseNetDev(t *testing.T) {
	content := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0`
	rx, tx := parseNetDev(content)
	if rx != 5000 || tx != 7000 { // lo excluded
		t.Fatalf("rx=%d tx=%d", rx, tx)
	}
}
