package config_test

import (
	"testing"
	"time"

	"github.com/Quad4-Software/dictationasm/internal/config"
)

func TestDefaultValidate(t *testing.T) {
	t.Parallel()
	cfg := config.Default()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config invalid: %v", err)
	}
}

func TestLoadFlags(t *testing.T) {
	t.Parallel()
	cfg, err := config.Load([]string{"-addr", ":9090", "-web", "web"})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Addr != ":9090" {
		t.Fatalf("addr=%q", cfg.Addr)
	}
	if cfg.WebRoot != "web" {
		t.Fatalf("web=%q", cfg.WebRoot)
	}
	if cfg.ReadTimeout < time.Second {
		t.Fatalf("unexpected read timeout %v", cfg.ReadTimeout)
	}
}

func TestValidateRejectsEmptyAddr(t *testing.T) {
	t.Parallel()
	cfg := config.Default()
	cfg.Addr = " "
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected error")
	}
}
