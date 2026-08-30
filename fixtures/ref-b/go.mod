// go.mod — module root for the Northwind Fleet telematics platform.

module github.com/northwind-fleet/telemetry-platform

go 1.22

require (
	github.com/aws/aws-sdk-go-v2 v1.30.3
	github.com/aws/aws-sdk-go-v2/config v1.27.27
	github.com/aws/aws-sdk-go-v2/service/dynamodb v1.34.4
	github.com/aws/aws-sdk-go-v2/service/s3 v1.58.2
	github.com/aws/aws-sdk-go-v2/service/kinesis v1.29.4
	github.com/jackc/pgx/v5 v5.6.0
	github.com/redis/go-redis/v9 v9.6.1
	google.golang.org/grpc v1.65.0
)
