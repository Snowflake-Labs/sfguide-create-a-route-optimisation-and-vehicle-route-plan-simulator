#!/bin/bash

MAX_RETRIES=20
RETRY_DELAY=5
ATTEMPT=1

echo "Checking if account $DATAOPS_SNOWFLAKE_ACCOUNT is ready..."

while [ $ATTEMPT -le $MAX_RETRIES ]; do
    echo "Attempt $ATTEMPT of $MAX_RETRIES"
    
    # Make request and capture response code
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$DATAOPS_SNOWFLAKE_ACCOUNT.snowflakecomputing.com")
    
    if [ $HTTP_CODE -eq 404 ]; then
        if [ $ATTEMPT -eq $MAX_RETRIES ]; then
            echo "Got 404"
            break
        fi
        echo "Got 404, retrying in $RETRY_DELAY seconds..."
        sleep $RETRY_DELAY
        ATTEMPT=$((ATTEMPT + 1))
    else
        echo "Got response code $HTTP_CODE"
        exit 0
    fi
done

echo "Max retries reached, giving up"
exit 1