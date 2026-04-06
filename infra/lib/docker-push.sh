#!/bin/bash
# Build and push Docker image to ECR
# Usage: ./docker-push.sh <account-id> <region>
ACCOUNT=$1
REGION=$2
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/ruin-app"
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REPO
docker build -t ruin-app -f ../Dockerfile ..
docker tag ruin-app:latest $REPO:latest
docker push $REPO:latest
