# discovery.tf — Cloud Map private DNS. Internal callers resolve service names
# under fleet.internal; the names are compiled into the Go clients rather than
# passed as environment variables, so this namespace is the only place the
# address appears in the infrastructure.

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "fleet.internal"
  description = "internal service discovery for ${local.name}"
  vpc         = aws_vpc.fleet.id
}

resource "aws_service_discovery_service" "dispatch" {
  name = "dispatch"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}
