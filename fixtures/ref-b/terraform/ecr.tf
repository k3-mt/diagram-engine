# ecr.tf — one image repository per binary in cmd/.

resource "aws_ecr_repository" "service" {
  for_each             = toset(local.services)
  name                 = "northwind-fleet/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}
