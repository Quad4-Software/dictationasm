# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Multi-stage rootless image for dictationasm.
# Base digests pinned to multi-arch OCI indexes (Alpine 3.24 / Go 1.26-alpine).

ARG ALPINE_DIGEST=sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
ARG GOLANG_DIGEST=sha256:ce864e7223ac17b1775e6fd0b4c0db580c2eb50e7953a427916379e4b92a1628

ARG VERSION=0.1.0
ARG REVISION=unknown
ARG CREATED=unknown

FROM golang:1.26-alpine@${GOLANG_DIGEST} AS builder

ARG VERSION
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/root/.cache/go-build \
	--mount=type=cache,target=/go/pkg/mod \
	GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
	go build \
		-trimpath \
		-buildvcs=false \
		-ldflags="-s -w -X github.com/Quad4-Software/dictationasm/internal/version.Version=${VERSION}" \
		-o /out/dictationasm \
		./cmd/dictationasm

FROM alpine:3.24@${ALPINE_DIGEST} AS models

RUN apk add --no-cache curl bash \
	&& mkdir -p /onnx-models /transformers

# transformers.js + onnxruntime-web for WebGPU and the WASM fallback
ARG TRANSFORMERS_JS_VERSION=3.7.2
RUN BASE="https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_JS_VERSION}/dist" \
	&& curl -L --fail --retry 5 --retry-delay 2 -o /transformers/transformers.min.js "$BASE/transformers.min.js" \
	&& curl -L --fail --retry 5 --retry-delay 2 -o /transformers/ort-wasm-simd-threaded.jsep.mjs "$BASE/ort-wasm-simd-threaded.jsep.mjs" \
	&& curl -L --fail --retry 5 --retry-delay 2 -o /transformers/ort-wasm-simd-threaded.jsep.wasm "$BASE/ort-wasm-simd-threaded.jsep.wasm"

# Moonshine ASR (fp32 encoder + q4/q8 decoders) and the Silero VAD model
COPY scripts/fetch-onnx-models.sh scripts/fetch-vad.sh /tmp/scripts/
RUN chmod +x /tmp/scripts/*.sh \
	&& ONNX_OUT=/onnx-models bash /tmp/scripts/fetch-onnx-models.sh

FROM alpine:3.24@${ALPINE_DIGEST} AS runtime

ARG VERSION
ARG REVISION
ARG CREATED
ARG ALPINE_DIGEST
ARG GOLANG_DIGEST

LABEL org.opencontainers.image.title="dictationasm" \
	org.opencontainers.image.description="Offline in-browser Moonshine dictation via WebGPU and WASM" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.revision="${REVISION}" \
	org.opencontainers.image.created="${CREATED}" \
	org.opencontainers.image.licenses="0BSD" \
	org.opencontainers.image.vendor="dictationasm" \
	org.opencontainers.image.source="https://github.com/Quad4-Software/dictationasm" \
	org.opencontainers.image.url="https://dictationasm.quad4.io" \
	org.opencontainers.image.documentation="https://github.com/Quad4-Software/dictationasm" \
	org.opencontainers.image.base.name="docker.io/library/alpine:3.24" \
	org.opencontainers.image.base.digest="${ALPINE_DIGEST}" \
	org.opencontainers.image.ref.name="dictationasm:${VERSION}"

RUN apk upgrade --no-cache \
	&& addgroup -g 65532 -S nonroot \
	&& adduser -u 65532 -S -D -H -G nonroot nonroot \
	&& mkdir -p /app/web/models /app/web/vendor/transformers \
	&& chown -R nonroot:nonroot /app

COPY --from=builder --chown=nonroot:nonroot /out/dictationasm /app/dictationasm
COPY --chown=nonroot:nonroot web /app/web
COPY --from=models --chown=nonroot:nonroot /onnx-models/ /app/web/models/onnx/
COPY --from=models --chown=nonroot:nonroot /transformers/ /app/web/vendor/transformers/

RUN test -f /app/web/models/onnx/moonshine-tiny-ONNX/onnx/encoder_model.onnx \
	&& test -f /app/web/models/onnx/moonshine-tiny-ONNX/onnx/decoder_model_merged_q4.onnx \
	&& test -f /app/web/models/onnx/silero-vad/onnx/model.onnx \
	&& test -f /app/web/vendor/transformers/transformers.min.js \
	&& chmod 0555 /app/dictationasm \
	&& chmod -R a-w /app/web

ENV DICTATIONASM_ADDR=":8080" \
	DICTATIONASM_WEB="/app/web" \
	HOME="/tmp"

WORKDIR /app
USER 65532:65532

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["/app/dictationasm"]
CMD ["-addr", ":8080", "-web", "/app/web"]
