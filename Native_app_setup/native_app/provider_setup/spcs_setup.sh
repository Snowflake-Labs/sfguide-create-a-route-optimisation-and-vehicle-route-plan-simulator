# authenticate with SPCS repository
snow spcs image-registry login -c HOL_TEST

REPO_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c HOL_TEST)

# command below should display image repository URL, in case of issues get it from here: https://docs.snowflake.com/en/developer-guide/snowpark-container-services/working-with-registry-repository#image-repository-url
echo $REPO_URL

# open decktor desktop and build and push images:

# openrouteservice image
cd services/openrouteservice
docker build --rm --platform linux/amd64 -t $REPO_URL/openrouteservice:v9.0.0 .
docker push $REPO_URL/openrouteservice:v9.0.0 

# gateway image
cd ../gateway
docker build --rm --platform linux/amd64 -t $REPO_URL/routing_reverse_proxy:v0.5.6 .
docker push $REPO_URL/routing_reverse_proxy:v0.5.6

# vroom image
cd ../vroom
docker build --rm --platform linux/amd64 -t $REPO_URL/vroom-docker:v1.0.1 .
docker push $REPO_URL/vroom-docker:v1.0.1

# downloader image
cd ../downloader
docker build --rm --platform linux/amd64 -t $REPO_URL/downloader:v0.0.3 .
docker push $REPO_URL/downloader:v0.0.3 

# go back to the working directory
cd ../..