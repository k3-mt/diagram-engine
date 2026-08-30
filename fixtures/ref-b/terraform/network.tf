# network.tf — one VPC, public subnets for the two internet-facing tasks,
# private subnets for everything else, and the security groups.

resource "aws_vpc" "fleet" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name}-vpc" }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.fleet.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.fleet.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.fleet.id
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.igw]
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

# Edge tasks: devices and the console reach these directly on the task IP.
resource "aws_security_group" "edge" {
  name   = "${local.name}-edge"
  vpc_id = aws_vpc.fleet.id

  ingress {
    description = "device and console TLS, terminated in-process"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# One security group for everything inside the cluster. Any task may open a
# connection to any other task's gRPC port; we do not maintain a per-pair rule
# set, so this group says nothing about which service calls which.
resource "aws_security_group" "internal" {
  name   = "${local.name}-internal"
  vpc_id = aws_vpc.fleet.id

  ingress {
    description = "intra-cluster grpc"
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = aws_vpc.fleet.id

  ingress {
    description     = "postgres from the cluster"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.internal.id, aws_security_group.edge.id]
  }
}
