# Create a Route Optimisation and Vehicle Route Plan Simulator

## Overview

## Step-By-Step Guide

1. Deploy app:
- go to working directory of the project
- in CoCo CLI type: "use the local skill from skills/deploy-route-optimizer"
- after the deployment, the link to the app will be provided, for first time use you must launch the application in the UI.
- the default map installed is for San Francisco

2. (optional) select a custom map 
- after the app is deployed, you can select a custom map
- type in CoCo CLI: "use the local skill from skills/ors-map-customization to change the map to New York". New York is provided as an example, other regions can be installed as well
- it is recommend to use the smallest map possible for your use case, working with bigger maps requires more compute power

3. (optional) deploy demo notebook and streamlit 
- prerequisite: New York map installed
- type in CoCo CLI "use the local skill from skills/deploy-demo"
