# Publish Provider Daemon to Docker Hub

$IMAGE_NAME = "kyneto/provider-daemon"
$VERSION = "latest"

Write-Host "1. Logging in to Docker Hub..."
docker login

Write-Host "2. Building Docker Image..."
# Build from the incentive-layer root context
docker build -t "$IMAGE_NAME`:$VERSION" -f Dockerfile.node ..

Write-Host "3. Pushing to Docker Hub..."
docker push "$IMAGE_NAME`:$VERSION"

Write-Host "Done! Image published to $IMAGE_NAME`:$VERSION"
