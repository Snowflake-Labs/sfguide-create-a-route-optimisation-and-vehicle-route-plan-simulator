import streamlit as st
import pandas as pd
import altair as alt
import os
import snowflake.connector

st.set_page_config(page_title="Facility Utilization", layout="wide")

SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_resource
def get_connection():
    return snowflake.connector.connect(
        connection_name=os.getenv("SNOWFLAKE_CONNECTION_NAME")
    )

def run_query(sql):
    conn = get_connection()
    return pd.read_sql(sql, conn)

st.title("Facility Utilization")
st.caption("Dwell time and vehicle occupancy analysis by facility")

col1, col2 = st.columns([1, 3])
with col1:
    loc_type = st.selectbox("Location Type", ["All", "WAREHOUSE", "RETAIL", "HGV_POLYGON", "OFFICIAL"])
    top_n = st.slider("Top N Facilities", 10, 50, 20)
    metric = st.radio("Rank by", ["TOTAL_DWELL_HOURS", "UNIQUE_VEHICLES", "AVG_DWELL_MIN"])

where = f"WHERE LOC_TYPE = '{loc_type}'" if loc_type != "All" else ""

data = run_query(f"""
    SELECT LOCATION_ID, LOCATION_NAME, CITY, FACILITY_TYPE, LOC_TYPE,
           SUM(UNIQUE_VEHICLES) AS UNIQUE_VEHICLES,
           SUM(TOTAL_SESSIONS) AS TOTAL_SESSIONS,
           ROUND(SUM(TOTAL_DWELL_MIN) / 60.0, 1) AS TOTAL_DWELL_HOURS,
           ROUND(AVG(AVG_DWELL_MIN), 1) AS AVG_DWELL_MIN,
           ROUND(MAX(MAX_DWELL_MIN), 1) AS MAX_DWELL_MIN
    FROM {SCHEMA}.DT_FACILITY_UTILIZATION
    {where}
    GROUP BY LOCATION_ID, LOCATION_NAME, CITY, FACILITY_TYPE, LOC_TYPE
    ORDER BY {metric} DESC
    LIMIT {top_n}
""")

with col2:
    if len(data) == 0:
        st.info("No data for selected filters.")
    else:
        bar = alt.Chart(data).mark_bar().encode(
            x=alt.X(f'{metric}:Q', title=metric.replace('_', ' ').title()),
            y=alt.Y('LOCATION_NAME:N', sort='-x', title='Facility'),
            color=alt.Color('LOC_TYPE:N', scale=alt.Scale(scheme='category10')),
            tooltip=['LOCATION_NAME:N', 'CITY:N', 'FACILITY_TYPE:N',
                     'UNIQUE_VEHICLES:Q', 'TOTAL_DWELL_HOURS:Q', 'AVG_DWELL_MIN:Q']
        ).properties(height=max(400, top_n * 22))
        st.altair_chart(bar, use_container_width=True)

st.divider()
st.subheader("Daily Utilization Timeline")

if loc_type != "All":
    timeline = run_query(f"""
        SELECT VISIT_DATE, SUM(UNIQUE_VEHICLES) AS VEHICLES, SUM(TOTAL_SESSIONS) AS SESSIONS,
               ROUND(AVG(AVG_DWELL_MIN), 1) AS AVG_DWELL
        FROM {SCHEMA}.DT_FACILITY_UTILIZATION
        WHERE LOC_TYPE = '{loc_type}'
        GROUP BY VISIT_DATE ORDER BY VISIT_DATE
    """)
else:
    timeline = run_query(f"""
        SELECT VISIT_DATE, SUM(UNIQUE_VEHICLES) AS VEHICLES, SUM(TOTAL_SESSIONS) AS SESSIONS,
               ROUND(AVG(AVG_DWELL_MIN), 1) AS AVG_DWELL
        FROM {SCHEMA}.DT_FACILITY_UTILIZATION
        GROUP BY VISIT_DATE ORDER BY VISIT_DATE
    """)

if len(timeline) > 0:
    line = alt.Chart(timeline).mark_line(point=True).encode(
        x='VISIT_DATE:T',
        y='VEHICLES:Q',
        tooltip=['VISIT_DATE:T', 'VEHICLES:Q', 'SESSIONS:Q', 'AVG_DWELL:Q']
    ).properties(height=300)
    st.altair_chart(line, use_container_width=True)

st.subheader("Facility Details")
st.dataframe(data, use_container_width=True, hide_index=True)
