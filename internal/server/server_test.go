package server_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Quad4-Software/dictationasm/internal/config"
	"github.com/Quad4-Software/dictationasm/internal/server"
)

func TestAPIAndStatic(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	index := filepath.Join(root, "index.html")
	if err := os.WriteFile(index, []byte("<html>ok</html>"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := config.Default()
	cfg.WebRoot = root
	cfg.Addr = "127.0.0.1:0"

	srv, err := server.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	client := ts.Client()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)

	res := mustGet(ctx, t, client, ts.URL+"/api/health")
	defer closeBody(t, res)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("health status %d", res.StatusCode)
	}
	if res.Header.Get("Cross-Origin-Embedder-Policy") != "require-corp" {
		t.Fatalf("missing COEP header")
	}

	res2 := mustGet(ctx, t, client, ts.URL+"/api/models")
	defer closeBody(t, res2)
	var payload map[string]any
	if err := json.NewDecoder(res2.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	models, ok := payload["models"].([]any)
	if !ok || len(models) == 0 {
		t.Fatalf("models payload: %#v", payload)
	}

	res3 := mustGet(ctx, t, client, ts.URL+"/")
	defer closeBody(t, res3)
	body, err := io.ReadAll(res3.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res3.StatusCode != http.StatusOK || string(body) != "<html>ok</html>" {
		t.Fatalf("static: %d %q", res3.StatusCode, body)
	}

	res4 := mustGet(ctx, t, client, ts.URL+"/api/models/does-not-exist")
	defer closeBody(t, res4)
	if res4.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 got %d", res4.StatusCode)
	}
}

func TestPWAAssets(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	files := map[string]string{
		"index.html":           "<html>ok</html>",
		"sw.js":                "self.addEventListener('fetch',()=>{});",
		"manifest.webmanifest": `{"name":"dictationasm","start_url":"/"}`,
	}
	for name, body := range files {
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	cfg := config.Default()
	cfg.WebRoot = root
	cfg.Addr = "127.0.0.1:0"
	srv, err := server.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	client := ts.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)

	res := mustGet(ctx, t, client, ts.URL+"/sw.js")
	defer closeBody(t, res)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("sw status %d", res.StatusCode)
	}
	if res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("sw cache header %q", res.Header.Get("Cache-Control"))
	}
	if res.Header.Get("Service-Worker-Allowed") != "/" {
		t.Fatalf("missing Service-Worker-Allowed")
	}

	res2 := mustGet(ctx, t, client, ts.URL+"/manifest.webmanifest")
	defer closeBody(t, res2)
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("manifest status %d", res2.StatusCode)
	}
	ct := res2.Header.Get("Content-Type")
	if !strings.Contains(ct, "manifest") {
		t.Fatalf("manifest content-type %q", ct)
	}
}

func mustGet(ctx context.Context, t *testing.T, client *http.Client, url string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func closeBody(t *testing.T, res *http.Response) {
	t.Helper()
	if err := res.Body.Close(); err != nil {
		t.Errorf("close body: %v", err)
	}
}
