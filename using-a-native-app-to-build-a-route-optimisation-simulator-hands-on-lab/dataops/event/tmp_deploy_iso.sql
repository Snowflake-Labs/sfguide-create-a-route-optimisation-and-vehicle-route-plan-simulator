use role ATTENDEE_ROLE;

create or replace streamlit VEHICLE_ROUTING_SIMULATOR.STREAMLIT.ISOCHRONES_VIEWER
    from @VEHICLE_ROUTING_SIMULATOR.STREAMLIT.STREAMLIT_ISOCHRONES
    main_file = 'isochrones.py'
    query_warehouse = 'DEFAULT_WH';


