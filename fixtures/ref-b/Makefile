# Makefile — Northwind Fleet telematics platform.
# Six binaries, one module. Images are built per binary and pushed to the
# repositories declared in terraform/ecr.tf; the ECS task definitions in
# terraform/ecs.tf pin the same six names.

SERVICES := ingest-gateway trip-builder geofence-eval fleet-api dispatch maintenance-forecast

.PHONY: build test $(SERVICES)

build: $(SERVICES)

$(SERVICES):
	CGO_ENABLED=0 go build -trimpath -o bin/$@ ./cmd/$@

test:
	go test ./...
