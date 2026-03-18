# authenticate with SPCS repository
snow spcs image-registry login -c <CONNECTION_NAME>

REPO_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <CONNECTION_NAME>)

# command below should display image repository URL, in case of issues get it from here: https://docs.snowflake.com/en/developer-guide/snowpark-container-services/working-with-registry-repository#image-repository-url
echo $REPO_URL

# build and push images (make sure you have docker desktop running in the background):

# openrouteservice image
cd services/openrouteservice
docker build --rm --platform linux/amd64 -t $REPO_URL/openrouteservice:v9.0.0 .
docker push $REPO_URL/openrouteservice:v9.0.0 

# downloader image
cd ../downloader
docker build --rm --platform linux/amd64 -t $REPO_URL/downloader:v0.0.3 .
docker push $REPO_URL/downloader:v0.0.3 

# gateway image
cd ../gateway
docker build --rm --platform linux/amd64 -t $REPO_URL/routing_reverse_proxy:v0.5.6 .
docker push $REPO_URL/routing_reverse_proxy:v0.5.6

# vroom image
cd ../vroom
docker build --rm --platform linux/amd64 -t $REPO_URL/vroom-docker:v1.0.1 .
docker push $REPO_URL/vroom-docker:v1.0.1

# go back to the working directory
cd ../..
