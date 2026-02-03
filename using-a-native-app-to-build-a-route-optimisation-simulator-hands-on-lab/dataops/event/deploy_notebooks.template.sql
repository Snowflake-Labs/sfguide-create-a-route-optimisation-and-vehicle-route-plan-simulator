ALTER SESSION SET QUERY_TAG = '''{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0},"attributes":{"is_quickstart":0, "source":"sql"}}''';

use role {{ env.EVENT_ATTENDEE_ROLE }};

create schema IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }};
create stage IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1;
create stage IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_2;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/routing_setup.ipynb @{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1 auto_compress = false overwrite = true;

CREATE OR REPLACE NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}."Routing With Open Routes With AISQL"
    FROM '@{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1'
    MAIN_FILE = 'routing_setup.ipynb'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"notebook"}}';

ALTER NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}."Routing With Open Routes With AISQL" ADD LIVE VERSION FROM LAST;



PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/Fleet_Management_Setup.ipynb @{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_2 auto_compress = false overwrite = true;
--PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_2-- auto_compress = false overwrite = true;


CREATE OR REPLACE NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}."Fleet Intelligence Setup"
    FROM '@{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_2'
    MAIN_FILE = 'Fleet_Management_Setup.ipynb'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Intelligence Lab", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"notebook"}}';

ALTER NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}."Fleet Intelligence Setup" ADD LIVE VERSION FROM LAST;