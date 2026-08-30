# main.tf — provider and shared locals for the Northwind Fleet platform.
#
# This directory is the whole infrastructure description: there is no compose
# file and no Helm chart anywhere in the repository. Everything that exists in
# an environment is declared here.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  backend "s3" {
    bucket         = "northwind-fleet-tfstate"
    key            = "telemetry-platform/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "northwind-fleet-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      system  = "telemetry-platform"
      env     = var.env
      owner   = "fleet-platform"
      managed = "terraform"
    }
  }
}

locals {
  name = "northwind-fleet-${var.env}"

  # The six binaries in cmd/. One ECR repository and one task definition each.
  services = [
    "ingest-gateway",
    "trip-builder",
    "geofence-eval",
    "fleet-api",
    "dispatch",
    "maintenance-forecast",
  ]

  # Services that run continuously as ECS services. maintenance-forecast is
  # absent on purpose: it is a scheduled one-shot task (schedules.tf).
  long_running = [
    "ingest-gateway",
    "trip-builder",
    "geofence-eval",
    "fleet-api",
    "dispatch",
  ]
}
