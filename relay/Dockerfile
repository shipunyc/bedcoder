# Build the relay as a single static binary (modernc SQLite is pure Go, so
# CGO can stay off) and ship it on a distroless base (~20MB image).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/relay ./cmd/relay

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/relay /relay
ENV BEDCODER_ADDR=:8787 \
    BEDCODER_DB=/data/bedcoder.db
EXPOSE 8787
VOLUME /data
ENTRYPOINT ["/relay"]
