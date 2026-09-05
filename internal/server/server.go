// Package server hosts the dictationasm HTTP front end and JSON API.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/Quad4-Software/dictationasm/internal/config"
	"github.com/Quad4-Software/dictationasm/internal/model"
	"github.com/Quad4-Software/dictationasm/internal/version"
)

// Server is the HTTP application.
type Server struct {
	cfg     config.Config
	catalog model.Catalog
	log     *slog.Logger
	http    *http.Server
	webFS   fs.FS
}

// New constructs a Server from config.
func New(cfg config.Config, log *slog.Logger) (*Server, error) {
	if log == nil {
		log = slog.Default()
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	info, err := os.Stat(cfg.WebRoot)
	if err != nil {
		return nil, fmt.Errorf("web root: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("web root is not a directory: %s", cfg.WebRoot)
	}

	s := &Server{
		cfg:     cfg,
		catalog: model.DefaultCatalog(),
		log:     log,
		webFS:   os.DirFS(cfg.WebRoot),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/version", s.handleVersion)
	mux.HandleFunc("GET /api/models", s.handleModels)
	mux.HandleFunc("GET /api/models/{id}", s.handleModelByID)
	mux.Handle("GET /", s.staticHandler())

	s.http = &http.Server{
		Addr:              cfg.Addr,
		Handler:           s.withMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}
	return s, nil
}

// Handler returns the HTTP handler for tests and custom listeners.
func (s *Server) Handler() http.Handler {
	return s.http.Handler
}

// ListenAndServe starts the HTTP server until ctx is cancelled.
func (s *Server) ListenAndServe(ctx context.Context) error {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", s.cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	s.log.Info("listening", "addr", ln.Addr().String(), "web", s.cfg.WebRoot)

	errCh := make(chan error, 1)
	go func() {
		errCh <- s.http.Serve(ln)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
		defer cancel()
		if err := s.http.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		err := <-errCh
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// Cross-origin isolation enables SharedArrayBuffer for onnxruntime-web threads.
		// All assets are same-origin so require-corp is safe and fully offline.
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "microphone=(self), camera=()")

		rw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		next.ServeHTTP(rw, r)
		s.log.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rw.code,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"name":    "dictationasm",
		"version": version.Version,
	})
}

func (s *Server) handleModels(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.catalog)
}

func (s *Server) handleModelByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m, ok := s.catalog.ByID(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "model not found"})
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) staticHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		clean := path.Clean("/" + r.URL.Path)
		rel := strings.TrimPrefix(clean, "/")
		if rel == "" || strings.HasSuffix(rel, "/") {
			rel = "index.html"
		}
		if !safeRelPath(rel) {
			http.NotFound(w, r)
			return
		}

		data, err := fs.ReadFile(s.webFS, rel)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && !strings.Contains(path.Base(rel), ".") {
				rel = "index.html"
				data, err = fs.ReadFile(s.webFS, rel)
			}
			if err != nil {
				http.NotFound(w, r)
				return
			}
		}

		setCacheHeaders(w, rel)
		http.ServeContent(w, r, rel, time.Time{}, bytes.NewReader(data))
	})
}

func safeRelPath(rel string) bool {
	if rel == "" || strings.Contains(rel, "\\") {
		return false
	}
	return !slices.Contains(strings.Split(rel, "/"), "..")
}

func setCacheHeaders(w http.ResponseWriter, rel string) {
	switch {
	case rel == "sw.js", rel == "manifest.webmanifest":
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasPrefix(rel, "models/"), strings.HasPrefix(rel, "vendor/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	case strings.HasSuffix(rel, ".wasm"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("Content-Type", "application/wasm")
	case strings.HasSuffix(rel, ".mjs"):
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case strings.HasSuffix(rel, ".onnx"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("Content-Type", "application/octet-stream")
	case rel == "index.html", strings.HasSuffix(rel, ".js"), strings.HasSuffix(rel, ".css"):
		w.Header().Set("Cache-Control", "no-cache")
	default:
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	if rel == "manifest.webmanifest" {
		w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
	}
	if rel == "sw.js" {
		w.Header().Set("Service-Worker-Allowed", "/")
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}
