import streamlit as st
import pandas as pd
import altair as alt
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Facility performance")
st.caption("Dwell distributions, throughput analysis, and utilization benchmarks")

col1, col2 = st.columns([1, 3])
with col1:
    loc_type = st.selectbox("Location type", ["All", "WAREHOUSE", "RETAIL", "HGV_POLYGON", "OFFICIAL"])
    top_n = st.slider("Top N facilities", 5, 30, 15)
    metric = st.segmented_control("Rank by", ["TOTAL_DWELL_HOURS", "UNIQUE_VEHICLES", "AVG_DWELL_MIN"], default="TOTAL_DWELL_HOURS")

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
        ).properties(height=max(300, top_n * 22))
        st.altair_chart(bar, use_container_width=True)

st.divider()

col_box, col_scatter = st.columns(2)

with col_box:
    st.subheader("Dwell distribution by facility (box plot)")
    if len(data) > 0:
        top_names = data['LOCATION_NAME'].tolist()
        names_str = ",".join([f"'{n}'" for n in top_names[:10]])
        box_data = run_query(f"""
            SELECT LOCATION_NAME, DWELL_MINUTES
            FROM {SCHEMA}.DT_DWELL_ENRICHED
            WHERE STATUS LIKE 'DWELL%' AND DWELL_MINUTES > 0
              AND LOCATION_NAME IN ({names_str})
        """)
        if len(box_data) > 0:
            boxplot = alt.Chart(box_data).mark_boxplot(extent='min-max').encode(
                x=alt.X('DWELL_MINUTES:Q', title='Dwell minutes', scale=alt.Scale(zero=True)),
                y=alt.Y('LOCATION_NAME:N', sort='-x', title='Facility'),
            ).properties(height=max(250, len(top_names[:10]) * 35))
            st.altair_chart(boxplot, use_container_width=True)
        else:
            st.info("No session-level data for selected facilities.")

with col_scatter:
    st.subheader("Throughput vs dwell")
    if len(data) > 0:
        scatter = alt.Chart(data).mark_circle().encode(
            x=alt.X('TOTAL_SESSIONS:Q', title='Total sessions (throughput)'),
            y=alt.Y('AVG_DWELL_MIN:Q', title='Avg dwell (min)'),
            size=alt.Size('UNIQUE_VEHICLES:Q', title='Unique vehicles', scale=alt.Scale(range=[50, 500])),
            color=alt.Color('LOC_TYPE:N', scale=alt.Scale(scheme='category10')),
            tooltip=['LOCATION_NAME:N', 'CITY:N', 'TOTAL_SESSIONS:Q', 'AVG_DWELL_MIN:Q', 'UNIQUE_VEHICLES:Q']
        ).properties(height=350)
        st.altair_chart(scatter, use_container_width=True)

st.divider()
st.subheader("Daily utilization timeline")

where_tl = f"WHERE LOC_TYPE = '{loc_type}'" if loc_type != "All" else ""
timeline = run_query(f"""
    SELECT VISIT_DATE, SUM(UNIQUE_VEHICLES) AS VEHICLES, SUM(TOTAL_SESSIONS) AS SESSIONS,
           ROUND(AVG(AVG_DWELL_MIN), 1) AS AVG_DWELL
    FROM {SCHEMA}.DT_FACILITY_UTILIZATION
    {where_tl}
    GROUP BY VISIT_DATE ORDER BY VISIT_DATE
""")

if len(timeline) > 0:
    line = alt.Chart(timeline).mark_line(point=True).encode(
        x='VISIT_DATE:T',
        y='VEHICLES:Q',
        tooltip=['VISIT_DATE:T', 'VEHICLES:Q', 'SESSIONS:Q', 'AVG_DWELL:Q']
    ).properties(height=300)
    st.altair_chart(line, use_container_width=True)

st.subheader("Facility details")
st.dataframe(data, hide_index=True)
