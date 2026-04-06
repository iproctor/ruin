import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export class RuinStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // Parameters
    // -------------------------------------------------------------------------
    const appUrlParam = new cdk.CfnParameter(this, "AppUrl", {
      type: "String",
      default: "http://localhost:3001",
      description: "Public URL of the application (e.g. https://ruin.example.com)",
    });

    // -------------------------------------------------------------------------
    // 1. VPC — 2 AZs, 1 NAT gateway
    // -------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, "RuinVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // 2. RDS PostgreSQL 15 — isolated subnet, single-AZ
    // -------------------------------------------------------------------------
    const dbSecret = new rds.DatabaseSecret(this, "RuinDbSecret", {
      username: "ruinuser",
    });

    const dbInstance = new rds.DatabaseInstance(this, "RuinDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "ruin",
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      backupRetention: cdk.Duration.days(7),
    });

    // -------------------------------------------------------------------------
    // 3. ECR Repository — mutable tags, keep last 5 images
    // -------------------------------------------------------------------------
    const ecrRepo = new ecr.Repository(this, "RuinEcrRepo", {
      repositoryName: "ruin-app",
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    ecrRepo.addLifecycleRule({
      description: "Keep last 5 images",
      maxImageCount: 5,
      rulePriority: 1,
      tagStatus: ecr.TagStatus.ANY,
    });

    // -------------------------------------------------------------------------
    // 4. ECS Cluster
    // -------------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, "RuinCluster", {
      vpc,
      clusterName: "ruin-cluster",
    });

    // -------------------------------------------------------------------------
    // 5. JWT Secret
    // -------------------------------------------------------------------------
    const jwtSecret = new secretsmanager.Secret(this, "RuinJwtSecret", {
      secretName: "ruin/jwt-secret",
      description: "JWT signing secret for Ruin",
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // -------------------------------------------------------------------------
    // 6. CloudWatch Log Group
    // -------------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, "RuinLogGroup", {
      logGroupName: "/ruin/app",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------------
    // 7. Fargate Task Definition
    // -------------------------------------------------------------------------
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "RuinTaskDef",
      {
        cpu: 512,
        memoryLimitMiB: 1024,
      }
    );

    // Grant task execution role access to secrets
    dbSecret.grantRead(taskDefinition.executionRole!);
    jwtSecret.grantRead(taskDefinition.executionRole!);

    // Build DATABASE_URL from the RDS secret fields
    const databaseUrl = cdk.Fn.join("", [
      "postgresql://",
      cdk.Fn.sub("{{resolve:secretsmanager:${SecretId}:SecretString:username}}", {
        SecretId: dbSecret.secretArn,
      }),
      ":",
      cdk.Fn.sub("{{resolve:secretsmanager:${SecretId}:SecretString:password}}", {
        SecretId: dbSecret.secretArn,
      }),
      "@",
      dbInstance.dbInstanceEndpointAddress,
      ":",
      dbInstance.dbInstanceEndpointPort,
      "/ruin",
    ]);

    const container = taskDefinition.addContainer("ruin-app", {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "ruin",
        logGroup,
      }),
      environment: {
        NODE_ENV: "production",
        PORT: "3001",
        DATABASE_URL: databaseUrl,
        APP_URL: appUrlParam.valueAsString,
        AWS_REGION: this.region,
      },
      secrets: {
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
      },
    });

    container.addPortMappings({
      containerPort: 3001,
      protocol: ecs.Protocol.TCP,
    });

    // -------------------------------------------------------------------------
    // 8. Application Load Balancer
    // -------------------------------------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, "RuinAlb", {
      vpc,
      internetFacing: true,
      loadBalancerName: "ruin-alb",
    });

    const httpListener = alb.addListener("HttpListener", {
      port: 80,
      open: true,
    });

    // TODO: Add HTTPS listener with ACM certificate
    // const httpsListener = alb.addListener("HttpsListener", {
    //   port: 443,
    //   certificates: [elbv2.ListenerCertificate.fromArn("<ACM_CERT_ARN>")],
    //   open: true,
    // });

    // -------------------------------------------------------------------------
    // 9. Fargate Service
    // -------------------------------------------------------------------------
    const fargateService = new ecs.FargateService(this, "RuinService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Allow ALB to reach the Fargate service on port 3001
    fargateService.connections.allowFrom(
      alb,
      ec2.Port.tcp(3001),
      "ALB to Fargate on port 3001"
    );

    // Allow Fargate to reach RDS on port 5432
    dbInstance.connections.allowFrom(
      fargateService,
      ec2.Port.tcp(5432),
      "Fargate to RDS on port 5432"
    );

    // Register Fargate service as ALB target
    httpListener.addTargets("RuinTarget", {
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [fargateService],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: "200-299",
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // -------------------------------------------------------------------------
    // 10. SES — manual verification required
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, "SesSetupInstructions", {
      description: "SES email identity setup",
      value: [
        "SES domain verification is manual.",
        "Steps:",
        "1. Go to AWS Console > SES > Verified Identities",
        "2. Click 'Create Identity' and choose 'Domain'",
        "3. Enter your sender domain and follow the DNS verification steps",
        "4. Request production access (move out of sandbox) via Support Center",
        "5. Set your verified sender address in the application config",
      ].join(" "),
    });

    // -------------------------------------------------------------------------
    // 11. Stack Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, "AlbDnsName", {
      description: "Application Load Balancer DNS name",
      value: alb.loadBalancerDnsName,
      exportName: "RuinAlbDnsName",
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      description: "ECR repository URI for docker push",
      value: ecrRepo.repositoryUri,
      exportName: "RuinEcrRepositoryUri",
    });

    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      description: "ARN of the RDS credentials secret in Secrets Manager",
      value: dbSecret.secretArn,
      exportName: "RuinDatabaseSecretArn",
    });

    new cdk.CfnOutput(this, "AppUrl", {
      description: "Application URL",
      value: `http://${alb.loadBalancerDnsName}`,
      exportName: "RuinAppUrl",
    });
  }
}
