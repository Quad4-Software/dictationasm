package audio_test

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/Quad4-Software/dictationasm/internal/audio"
)

func TestDecodeAndResampleWAV(t *testing.T) {
	t.Parallel()
	wav := synthWAV(8000, 8000, 440)
	pcm, err := audio.DecodeWAVMonoF32(wav)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if pcm.SampleRate != 8000 {
		t.Fatalf("rate=%d", pcm.SampleRate)
	}
	out, err := audio.ToDictationPCM(pcm)
	if err != nil {
		t.Fatalf("to dictation pcm: %v", err)
	}
	if out.SampleRate != audio.DictationSampleRate {
		t.Fatalf("out rate=%d", out.SampleRate)
	}
	if len(out.Samples) < 15000 || len(out.Samples) > 17000 {
		t.Fatalf("unexpected sample count %d", len(out.Samples))
	}
}

func TestResampleIntoZeroAlloc(t *testing.T) {
	t.Parallel()
	in := audio.PCMF32{
		SampleRate: 8000,
		Samples:    make([]float32, 8000),
	}
	for i := range in.Samples {
		in.Samples[i] = float32(math.Sin(float64(i) * 0.01))
	}
	dst := make([]float32, 16000)
	out, err := audio.ResampleLinearInto(in, 16000, dst[:0])
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Samples) != 16000 {
		t.Fatalf("len=%d", len(out.Samples))
	}
	if &out.Samples[0] != &dst[0] {
		t.Fatal("expected dst reuse")
	}
	out2, err := audio.ResampleLinearInto(in, 16000, out.Samples[:0])
	if err != nil {
		t.Fatal(err)
	}
	if len(out2.Samples) != 16000 {
		t.Fatalf("len2=%d", len(out2.Samples))
	}
	if &out2.Samples[0] != &dst[0] {
		t.Fatal("expected dst reuse on second pass")
	}
}

func TestValidateRejectsBadRate(t *testing.T) {
	t.Parallel()
	p := audio.PCMF32{SampleRate: 44100, Samples: []float32{0.1}}
	if err := p.Validate(); err == nil {
		t.Fatal("expected error")
	}
}

func TestDecodeFixtureFiles(t *testing.T) {
	t.Parallel()
	root := filepath.Join("..", "..", "testdata")
	files := []string{"jfk.wav", "hello16.wav", "hello.wav"}
	for _, name := range files {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(root, name)
			data, err := os.ReadFile(path) // #nosec G304 -- fixed testdata filenames
			if err != nil {
				t.Skip(err)
			}
			pcm, err := audio.DecodeWAVMonoF32(data)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := audio.ToDictationPCM(pcm)
			if err != nil {
				t.Fatalf("dictation pcm: %v", err)
			}
			if len(out.Samples) < 1000 {
				t.Fatalf("too short: %d", len(out.Samples))
			}
		})
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	t.Parallel()
	if _, err := audio.DecodeWAVMonoF32([]byte("not a wav")); err == nil {
		t.Fatal("expected error")
	}
}

func BenchmarkDecodeMono16(b *testing.B) {
	wav := synthWAV(16000, 16000*10, 440)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := audio.DecodeWAVMonoF32(wav); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkResampleInto(b *testing.B) {
	in := audio.PCMF32{SampleRate: 44100, Samples: make([]float32, 44100)}
	dst := make([]float32, 0, 16000)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		out, err := audio.ResampleLinearInto(in, 16000, dst[:0])
		if err != nil {
			b.Fatal(err)
		}
		dst = out.Samples[:0]
	}
}

func synthWAV(sampleRate, nSamples int, freq float64) []byte {
	dataSize := nSamples * 2
	buf := make([]byte, 44+dataSize)
	copy(buf[0:4], "RIFF")
	putU32(buf[4:8], 36+dataSize)
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	putU32(buf[16:20], 16)
	binary.LittleEndian.PutUint16(buf[20:22], 1)
	binary.LittleEndian.PutUint16(buf[22:24], 1)
	putU32(buf[24:28], sampleRate)
	putU32(buf[28:32], sampleRate*2)
	binary.LittleEndian.PutUint16(buf[32:34], 2)
	binary.LittleEndian.PutUint16(buf[34:36], 16)
	copy(buf[36:40], "data")
	putU32(buf[40:44], dataSize)
	for i := range nSamples {
		v := math.Sin(2 * math.Pi * freq * float64(i) / float64(sampleRate))
		sample := int16(v * 30000)
		binary.LittleEndian.PutUint16(buf[44+i*2:46+i*2], uint16(sample)) // #nosec G115 -- test fixture PCM
	}
	return buf
}

func putU32(b []byte, v int) {
	if v < 0 {
		v = 0
	}
	binary.LittleEndian.PutUint32(b, uint32(v)) // #nosec G115 -- bounded test fixture sizes
}
