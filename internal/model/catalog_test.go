package model_test

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Quad4-Software/dictationasm/internal/model"
)

func TestDefaultCatalog(t *testing.T) {
	t.Parallel()
	c := model.DefaultCatalog()
	if len(c.Models) == 0 {
		t.Fatal("empty catalog")
	}
	def, ok := c.DefaultModel()
	if !ok || !def.Default {
		t.Fatalf("missing default model: %+v", def)
	}
	if def.Engine != model.EngineAuto {
		t.Fatalf("engine=%s", def.Engine)
	}
	if def.OnnxID != "moonshine-tiny-ONNX" {
		t.Fatalf("onnx_id=%s", def.OnnxID)
	}
	if !strings.HasPrefix(def.Path, "/models/onnx/") {
		t.Fatalf("path=%s", def.Path)
	}
	got, ok := c.ByID(def.ID)
	if !ok || got.Path == "" {
		t.Fatalf("by id failed: %+v", got)
	}
	ids := c.IDs()
	if len(ids) != len(c.Models) {
		t.Fatalf("ids len %d", len(ids))
	}
}

func TestCatalogIsMoonshineEnglish(t *testing.T) {
	t.Parallel()
	c := model.DefaultCatalog()
	if len(c.Models) < 2 {
		t.Fatalf("expected quick and clearer models, got %d", len(c.Models))
	}
	for _, m := range c.Models {
		if !strings.HasPrefix(m.OnnxID, "moonshine-") {
			t.Fatalf("%s is not a moonshine build: %s", m.ID, m.OnnxID)
		}
		if m.Language != "en" {
			t.Fatalf("%s language=%s", m.ID, m.Language)
		}
		if m.Path != "/models/onnx/"+m.OnnxID {
			t.Fatalf("%s path=%s", m.ID, m.Path)
		}
		if m.SizeHintMB <= 0 {
			t.Fatalf("%s size hint=%v", m.ID, m.SizeHintMB)
		}
	}
	clearer, ok := c.ByID("moonshine-base")
	if !ok || clearer.Optional || clearer.Default {
		t.Fatalf("clearer flags: %+v", clearer)
	}
	if clearer.Label != "Clearer" {
		t.Fatalf("clearer label=%s", clearer.Label)
	}
}

func TestDefaultVAD(t *testing.T) {
	t.Parallel()
	v := model.DefaultCatalog().VAD
	if v.OnnxID != "silero-vad" {
		t.Fatalf("onnx_id=%s", v.OnnxID)
	}
	if v.Path != "/models/onnx/silero-vad" {
		t.Fatalf("path=%s", v.Path)
	}
}

func TestByIDMissing(t *testing.T) {
	t.Parallel()
	c := model.DefaultCatalog()
	_, ok := c.ByID("nope")
	if ok {
		t.Fatal("expected miss")
	}
}

// TestStaticCatalogMatchesGo keeps web/models.json in lockstep with the Go
// catalog so GitHub Pages and the server offer the same models.
func TestStaticCatalogMatchesGo(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../web/models.json")
	if err != nil {
		t.Fatalf("read models.json: %v", err)
	}
	var static model.Catalog
	if err := json.Unmarshal(raw, &static); err != nil {
		t.Fatalf("parse models.json: %v", err)
	}
	want := model.DefaultCatalog()
	if !reflect.DeepEqual(static, want) {
		t.Fatalf("models.json drifted from DefaultCatalog\nstatic: %+v\ngo:     %+v", static, want)
	}
}
