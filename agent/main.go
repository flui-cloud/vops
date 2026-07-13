// vops-agent — an optional, single static binary that prints one JSON snapshot of
// in-guest metrics (cpu/mem/load/disk/net) and exits. One-shot, no daemon, no
// network of its own: a cron line or `vops host status` invokes it. It exists for
// providers whose control-plane API does not expose metrics (unlike Hetzner) and
// for minimal images where the shell battery's tools vary.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Version is stamped at build time via -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println(Version)
		return
	}
	out, err := json.Marshal(collect())
	if err != nil {
		fmt.Fprintln(os.Stderr, "vops-agent:", err)
		os.Exit(1)
	}
	fmt.Println(string(out))
}
