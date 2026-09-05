// Command dictationasm serves the in-browser Moonshine dictation UI.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/Quad4-Software/dictationasm/internal/config"
	"github.com/Quad4-Software/dictationasm/internal/server"
	"github.com/Quad4-Software/dictationasm/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		return 2
	}

	log.Info("dictationasm", "version", version.Version)

	srv, err := server.New(cfg, log)
	if err != nil {
		log.Error("server init failed", "err", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := srv.ListenAndServe(ctx); err != nil {
		log.Error("server stopped", "err", err)
		return 1
	}
	log.Info("shutdown complete")
	return 0
}
