// Package config loads runtime settings from flags and environment.
package config

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds process settings for the HTTP front end.
type Config struct {
	Addr            string
	WebRoot         string
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	IdleTimeout     time.Duration
	ShutdownTimeout time.Duration
}

// Default returns a Config with safe local-dev defaults.
func Default() Config {
	return Config{
		Addr:            ":8080",
		WebRoot:         "web",
		ReadTimeout:     15 * time.Second,
		WriteTimeout:    60 * time.Second,
		IdleTimeout:     60 * time.Second,
		ShutdownTimeout: 10 * time.Second,
	}
}

// Load parses flags then applies environment overrides.
func Load(args []string) (Config, error) {
	cfg := Default()
	fs := flag.NewFlagSet("dictationasm", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	fs.StringVar(&cfg.Addr, "addr", cfg.Addr, "HTTP listen address")
	fs.StringVar(&cfg.WebRoot, "web", cfg.WebRoot, "static web root directory")
	fs.DurationVar(&cfg.ReadTimeout, "read-timeout", cfg.ReadTimeout, "HTTP read timeout")
	fs.DurationVar(&cfg.WriteTimeout, "write-timeout", cfg.WriteTimeout, "HTTP write timeout")
	fs.DurationVar(&cfg.IdleTimeout, "idle-timeout", cfg.IdleTimeout, "HTTP idle timeout")
	fs.DurationVar(&cfg.ShutdownTimeout, "shutdown-timeout", cfg.ShutdownTimeout, "graceful shutdown timeout")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	if v, ok := os.LookupEnv("DICTATIONASM_ADDR"); ok && v != "" {
		cfg.Addr = v
	}
	if v, ok := os.LookupEnv("DICTATIONASM_WEB"); ok && v != "" {
		cfg.WebRoot = v
	}
	if v, ok := os.LookupEnv("DICTATIONASM_READ_TIMEOUT"); ok && v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("DICTATIONASM_READ_TIMEOUT: %w", err)
		}
		cfg.ReadTimeout = d
	}
	if v, ok := os.LookupEnv("DICTATIONASM_WRITE_TIMEOUT"); ok && v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("DICTATIONASM_WRITE_TIMEOUT: %w", err)
		}
		cfg.WriteTimeout = d
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate checks Config values that would break serving.
func (c Config) Validate() error {
	if strings.TrimSpace(c.Addr) == "" {
		return fmt.Errorf("addr must not be empty")
	}
	if strings.TrimSpace(c.WebRoot) == "" {
		return fmt.Errorf("web root must not be empty")
	}
	if c.ReadTimeout <= 0 {
		return fmt.Errorf("read timeout must be positive")
	}
	if c.WriteTimeout <= 0 {
		return fmt.Errorf("write timeout must be positive")
	}
	if c.IdleTimeout <= 0 {
		return fmt.Errorf("idle timeout must be positive")
	}
	if c.ShutdownTimeout <= 0 {
		return fmt.Errorf("shutdown timeout must be positive")
	}
	return nil
}

// Port extracts the numeric port from Addr when possible.
func (c Config) Port() (int, bool) {
	_, port, ok := strings.Cut(c.Addr, ":")
	if !ok || port == "" {
		return 0, false
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		return 0, false
	}
	return n, true
}
