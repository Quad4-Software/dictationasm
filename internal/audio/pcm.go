// Package audio provides low-allocation PCM helpers for dictation prep and tests.
package audio

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

const (
	// DictationSampleRate is the sample rate Moonshine expects.
	DictationSampleRate = 16000
	// MaxDurationSec caps decoded audio length for safety.
	MaxDurationSec = 30 * 60
)

var (
	errWAVTooShort     = errors.New("wav too short")
	errNotWAVE         = errors.New("not a RIFF WAVE file")
	errInvalidChunk    = errors.New("invalid wav chunk")
	errFmtShort        = errors.New("fmt chunk too short")
	errMissingData     = errors.New("missing data chunk")
	errIncompleteFmt   = errors.New("incomplete fmt chunk")
	errEmptyPCM        = errors.New("empty pcm")
	errInvalidChannels = errors.New("invalid channel count")
	errInvalidBits     = errors.New("invalid bits per sample")
	errTruncatedPCM    = errors.New("truncated pcm frames")
	errEmptyInput      = errors.New("empty input")
	errBadTargetRate   = errors.New("invalid target rate")
	errResampleEmpty   = errors.New("resample produced no samples")
)

// PCMF32 is mono float32 PCM in the range roughly [-1, 1].
type PCMF32 struct {
	SampleRate int
	Samples    []float32
}

// Duration returns the clip length.
func (p PCMF32) Duration() float64 {
	if p.SampleRate <= 0 || len(p.Samples) == 0 {
		return 0
	}
	return float64(len(p.Samples)) / float64(p.SampleRate)
}

// Validate checks basic PCM constraints.
func (p PCMF32) Validate() error {
	if p.SampleRate != DictationSampleRate {
		return fmt.Errorf("sample rate must be %d Hz got %d", DictationSampleRate, p.SampleRate)
	}
	if len(p.Samples) == 0 {
		return errEmptyPCM
	}
	if p.Duration() > MaxDurationSec {
		return fmt.Errorf("audio longer than %d seconds", MaxDurationSec)
	}
	return nil
}

// DecodeWAVMonoF32 decodes a PCM WAV into mono float32 at the source rate.
// Only uncompressed PCM (format 1) and IEEE float (format 3) are accepted.
func DecodeWAVMonoF32(data []byte) (PCMF32, error) {
	if len(data) < 44 {
		return PCMF32{}, errWAVTooShort
	}
	if fourCC(data[0:4]) != riffID || fourCC(data[8:12]) != waveID {
		return PCMF32{}, errNotWAVE
	}

	var (
		audioFormat   uint16
		numChannels   uint16
		sampleRate    uint32
		bitsPerSample uint16
		pcmData       []byte
		haveFmt       bool
	)

	offset := 12
	for offset+8 <= len(data) {
		id := fourCC(data[offset : offset+4])
		chunkSize := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		offset += 8
		if chunkSize < 0 || offset+chunkSize > len(data) {
			return PCMF32{}, errInvalidChunk
		}
		chunk := data[offset : offset+chunkSize]
		switch id {
		case fmtID:
			if len(chunk) < 16 {
				return PCMF32{}, errFmtShort
			}
			audioFormat = binary.LittleEndian.Uint16(chunk[0:2])
			numChannels = binary.LittleEndian.Uint16(chunk[2:4])
			sampleRate = binary.LittleEndian.Uint32(chunk[4:8])
			bitsPerSample = binary.LittleEndian.Uint16(chunk[14:16])
			haveFmt = true
		case dataID:
			pcmData = chunk
		}
		offset += chunkSize
		if chunkSize%2 == 1 {
			offset++
		}
	}

	if pcmData == nil {
		return PCMF32{}, errMissingData
	}
	if !haveFmt || numChannels == 0 || sampleRate == 0 || bitsPerSample == 0 {
		return PCMF32{}, errIncompleteFmt
	}
	if audioFormat != 1 && audioFormat != 3 {
		return PCMF32{}, fmt.Errorf("unsupported wav format %d", audioFormat)
	}

	samples, err := decodePCM(pcmData, int(numChannels), int(bitsPerSample), audioFormat)
	if err != nil {
		return PCMF32{}, err
	}
	return PCMF32{SampleRate: int(sampleRate), Samples: samples}, nil
}

const (
	riffID = 0x46464952 // RIFF
	waveID = 0x45564157 // WAVE
	fmtID  = 0x20746D66 // fmt
	dataID = 0x61746164 // data
)

func fourCC(b []byte) uint32 {
	return binary.LittleEndian.Uint32(b)
}

func decodePCM(data []byte, channels, bits int, format uint16) ([]float32, error) {
	if channels < 1 {
		return nil, errInvalidChannels
	}
	bytesPerSample := bits / 8
	if bytesPerSample <= 0 {
		return nil, errInvalidBits
	}
	frameSize := bytesPerSample * channels
	if frameSize == 0 || len(data)%frameSize != 0 {
		return nil, errTruncatedPCM
	}
	frames := len(data) / frameSize
	out := make([]float32, frames)

	// Fast path: mono PCM16.
	if format == 1 && channels == 1 && bits == 16 {
		for i := range frames {
			u := binary.LittleEndian.Uint16(data[i*2 : i*2+2])
			v := int16(u) // #nosec G115 -- intentional two's-complement PCM decode
			out[i] = float32(v) * (1.0 / 32768.0)
		}
		return out, nil
	}

	for i := range frames {
		base := i * frameSize
		var sum float64
		for ch := range channels {
			off := base + ch*bytesPerSample
			sum += sampleAt(data[off:off+bytesPerSample], bits, format)
		}
		out[i] = float32(sum / float64(channels))
	}
	return out, nil
}

func sampleAt(b []byte, bits int, format uint16) float64 {
	switch {
	case format == 3 && bits == 32 && len(b) >= 4:
		bits32 := binary.LittleEndian.Uint32(b)
		return float64(math.Float32frombits(bits32))
	case format == 1 && bits == 16 && len(b) >= 2:
		u := binary.LittleEndian.Uint16(b)
		v := int16(u) // #nosec G115 -- intentional two's-complement PCM decode
		return float64(v) / 32768.0
	case format == 1 && bits == 8 && len(b) >= 1:
		return (float64(b[0]) - 128.0) / 128.0
	case format == 1 && bits == 32 && len(b) >= 4:
		u := binary.LittleEndian.Uint32(b)
		v := int32(u) // #nosec G115 -- intentional two's-complement PCM decode
		return float64(v) / 2147483648.0
	default:
		return 0
	}
}

// ResampleLinear resamples mono PCM with linear interpolation.
// When dst is large enough the result is written into dst (zero extra alloc).
func ResampleLinear(in PCMF32, targetRate int) (PCMF32, error) {
	return ResampleLinearInto(in, targetRate, nil)
}

// ResampleLinearInto is like ResampleLinear but reuses dst when capacity allows.
func ResampleLinearInto(in PCMF32, targetRate int, dst []float32) (PCMF32, error) {
	if targetRate <= 0 {
		return PCMF32{}, errBadTargetRate
	}
	if in.SampleRate <= 0 || len(in.Samples) == 0 {
		return PCMF32{}, errEmptyInput
	}
	if in.SampleRate == targetRate {
		if cap(dst) >= len(in.Samples) {
			out := dst[:len(in.Samples)]
			copy(out, in.Samples)
			return PCMF32{SampleRate: targetRate, Samples: out}, nil
		}
		out := make([]float32, len(in.Samples))
		copy(out, in.Samples)
		return PCMF32{SampleRate: targetRate, Samples: out}, nil
	}

	ratio := float64(in.SampleRate) / float64(targetRate)
	outLen := int(math.Floor(float64(len(in.Samples)) / ratio))
	if outLen < 1 {
		return PCMF32{}, errResampleEmpty
	}
	var out []float32
	if cap(dst) >= outLen {
		out = dst[:outLen]
	} else {
		out = make([]float32, outLen)
	}
	last := len(in.Samples) - 1
	for i := range outLen {
		src := float64(i) * ratio
		idx := int(src)
		frac := float32(src - float64(idx))
		s0 := in.Samples[idx]
		s1 := s0
		if idx < last {
			s1 = in.Samples[idx+1]
		}
		out[i] = s0 + (s1-s0)*frac
	}
	return PCMF32{SampleRate: targetRate, Samples: out}, nil
}

// ToDictationPCM validates and resamples audio to the Moonshine input shape.
func ToDictationPCM(in PCMF32) (PCMF32, error) {
	out, err := ResampleLinear(in, DictationSampleRate)
	if err != nil {
		return PCMF32{}, err
	}
	if err := out.Validate(); err != nil {
		return PCMF32{}, err
	}
	return out, nil
}

// ToDictationPCMInto is ToDictationPCM with optional destination reuse.
func ToDictationPCMInto(in PCMF32, dst []float32) (PCMF32, error) {
	out, err := ResampleLinearInto(in, DictationSampleRate, dst)
	if err != nil {
		return PCMF32{}, err
	}
	if err := out.Validate(); err != nil {
		return PCMF32{}, err
	}
	return out, nil
}
