# schedules.tf — maintenance-forecast is not a service. EventBridge runs it as
# a one-shot Fargate task at 02:15 UTC and the task exits when it is done.

resource "aws_cloudwatch_event_rule" "nightly_forecast" {
  name                = "${local.name}-nightly-forecast"
  description         = "run maintenance-forecast once a night"
  schedule_expression = "cron(15 2 * * ? *)"
}

resource "aws_cloudwatch_event_target" "nightly_forecast" {
  rule     = aws_cloudwatch_event_rule.nightly_forecast.name
  arn      = aws_ecs_cluster.fleet.arn
  role_arn = aws_iam_role.events_invoke_ecs.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.service["maintenance-forecast"].arn
    task_count          = 1
    launch_type         = "FARGATE"

    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.internal.id]
      assign_public_ip = false
    }
  }
}
