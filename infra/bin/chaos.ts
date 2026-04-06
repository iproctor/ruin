#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { RuinStack } from "../lib/ruin-stack";

const app = new cdk.App();

new RuinStack(app, "RuinStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
