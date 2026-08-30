# variables.tf — inputs. Values per environment live in envs/*.tfvars.

variable "env" {
  description = "Environment name, used in every resource name."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS region. The platform is single-region."
  type        = string
  default     = "eu-west-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "db_instance_class" {
  description = "RDS instance class for fleetdb."
  type        = string
  default     = "db.r6g.large"
}

variable "stream_shards" {
  description = "Shard count on the telemetry stream. One shard per ~1000 vehicles."
  type        = number
  default     = 4
}

variable "routing_base_url" {
  description = "Waypoint Labs routing API base URL. Consumed by dispatch only."
  type        = string
  default     = "https://api.waypointlabs.io"
}

variable "position_cache_endpoint" {
  description = "Redis endpoint for the position cache (FLEET-812)."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}
