// Package model describes the Moonshine ONNX models served from local disk.
package model

import "slices"

// Engine identifies a browser dictation backend.
type Engine string

const (
	// EngineMoonshine runs Moonshine ONNX through transformers.js on WebGPU.
	EngineMoonshine Engine = "moonshine-webgpu"
	// EngineAuto prefers WebGPU and falls back to the onnxruntime-web WASM backend.
	EngineAuto Engine = "auto"
)

// Model is a selectable dictation model.
type Model struct {
	ID           string  `json:"id"`
	Label        string  `json:"label"`
	Engine       Engine  `json:"engine"`
	OnnxID       string  `json:"onnx_id"`
	Path         string  `json:"path"`
	Language     string  `json:"language"`
	SizeHintMB   float64 `json:"size_hint_mb"`
	SpeedRank    int     `json:"speed_rank"`
	AccuracyRank int     `json:"accuracy_rank"`
	Default      bool    `json:"default,omitempty"`
	Optional     bool    `json:"optional,omitempty"`
	Notes        string  `json:"notes,omitempty"`
}

// VAD describes the Silero voice-activity model that segments live speech.
type VAD struct {
	ID         string  `json:"id"`
	OnnxID     string  `json:"onnx_id"`
	Path       string  `json:"path"`
	SizeHintMB float64 `json:"size_hint_mb"`
}

// Catalog is the ordered list of models exposed by the API.
type Catalog struct {
	Models []Model `json:"models"`
	VAD    VAD     `json:"vad"`
}

// DefaultVAD returns the Silero VAD descriptor used for utterance detection.
func DefaultVAD() VAD {
	return VAD{
		ID:         "silero-vad",
		OnnxID:     "silero-vad",
		Path:       "/models/onnx/silero-vad",
		SizeHintMB: 2.2,
	}
}

// DefaultCatalog returns the built-in local Moonshine models (no network).
func DefaultCatalog() Catalog {
	return Catalog{
		Models: []Model{
			{
				ID:           "moonshine-tiny",
				Label:        "Quick",
				Engine:       EngineAuto,
				OnnxID:       "moonshine-tiny-ONNX",
				Path:         "/models/onnx/moonshine-tiny-ONNX",
				Language:     "en",
				SizeHintMB:   76,
				SpeedRank:    5,
				AccuracyRank: 3,
				Default:      true,
				Notes:        "Fastest. WebGPU when available, WASM fallback.",
			},
			{
				ID:           "moonshine-base",
				Label:        "Clearer",
				Engine:       EngineAuto,
				OnnxID:       "moonshine-base-ONNX",
				Path:         "/models/onnx/moonshine-base-ONNX",
				Language:     "en",
				SizeHintMB:   154,
				SpeedRank:    3,
				AccuracyRank: 5,
				Notes:        "Moonshine Base. Clearer Small/Streaming option.",
			},
		},
		VAD: DefaultVAD(),
	}
}

// ByID returns a model or false when unknown.
func (c *Catalog) ByID(id string) (Model, bool) {
	if c == nil {
		return Model{}, false
	}
	for i := range c.Models {
		if c.Models[i].ID == id {
			return c.Models[i], true
		}
	}
	return Model{}, false
}

// DefaultModel returns the catalog default or the first entry.
func (c *Catalog) DefaultModel() (Model, bool) {
	if c == nil {
		return Model{}, false
	}
	for i := range c.Models {
		if c.Models[i].Default {
			return c.Models[i], true
		}
	}
	if len(c.Models) == 0 {
		return Model{}, false
	}
	return c.Models[0], true
}

// IDs returns model identifiers in catalog order.
func (c *Catalog) IDs() []string {
	if c == nil {
		return nil
	}
	ids := make([]string, 0, len(c.Models))
	for i := range c.Models {
		ids = append(ids, c.Models[i].ID)
	}
	return slices.Clone(ids)
}
