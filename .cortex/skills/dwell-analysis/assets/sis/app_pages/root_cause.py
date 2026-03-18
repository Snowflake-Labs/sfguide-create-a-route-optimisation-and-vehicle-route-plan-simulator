import streamlit as st
import pandas as pd
import altair as alt
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Root cause analysis")
st.caption("Identify top dwell contributors, driver profile correlations, and temporal patterns")

st.subheader("Pareto analysis — dwell minutes by type")
pareto = run_query(f"""
    SELECT STATUS,
           SUM(DWELL_MINUTES) AS TOTAL_MIN,
           ROUND(SUM(SUM(DWELL_MINUTES)) OVER (ORDER BY SUM(DWELL_MINUTES) DESC)
             / SUM(SUM(DWELL_MINUTES)) OVER () * 100, 1) AS CUMULATIVE_PCT
    FROM {SCHEMA}.DT_DWELL_ENRICHED
    WHERE STATUS LIKE 'DWELL%' AND DWELL_MINUTES > 0
    GROUP BY STATUS ORDER BY TOTAL_MIN DESC
""")

if len(pareto) > 0:
    bars = alt.Chart(pareto).mark_bar().encode(
        x=alt.X('STATUS:N', sort='-y', title='Dwell type'),
        y=alt.Y('TOTAL_MIN:Q', title='Total dwell minutes'),
        tooltip=['STATUS:N', alt.Tooltip('TOTAL_MIN:Q', format=',.0f'), 'CUMULATIVE_PCT:Q']
    )
    line = alt.Chart(pareto).mark_line(color='red', point=True).encode(
        x=alt.X('STATUS:N', sort=alt.EncodingSortField(field='TOTAL_MIN', order='descending')),
        y=alt.Y('CUMULATIVE_PCT:Q', title='Cumulative %', scale=alt.Scale(domain=[0, 100])),
        tooltip=['STATUS:N', 'CUMULATIVE_PCT:Q']
    )
    combined = alt.layer(bars, line).resolve_scale(y='independent').properties(height=350)
    st.altair_chart(combined, use_container_width=True)

st.divider()

col_left, col_right = st.columns(2)

with col_left:
    st.subheader("Driver profile vs dwell type")
    profile_dwell = run_query(f"""
        SELECT DRIVER_PROFILE, STATUS,
               ROUND(AVG(DWELL_MINUTES), 1) AS AVG_DWELL,
               COUNT(*) AS SESSION_COUNT
        FROM {SCHEMA}.DT_DWELL_ENRICHED
        WHERE STATUS LIKE 'DWELL%' AND DWELL_MINUTES > 0
        GROUP BY DRIVER_PROFILE, STATUS
    """)

    if len(profile_dwell) > 0:
        grouped = alt.Chart(profile_dwell).mark_bar().encode(
            x=alt.X('DRIVER_PROFILE:N', title='Driver profile', sort=['COMPLIANT', 'MILD', 'OUTLIER']),
            y=alt.Y('AVG_DWELL:Q', title='Avg dwell (min)'),
            color=alt.Color('STATUS:N', scale=alt.Scale(scheme='category10'), title='Dwell type'),
            xOffset='STATUS:N',
            tooltip=['DRIVER_PROFILE:N', 'STATUS:N', 'AVG_DWELL:Q', 'SESSION_COUNT:Q']
        ).properties(height=350)
        st.altair_chart(grouped, use_container_width=True)

with col_right:
    st.subheader("Shift start time vs dwell")
    shift_dwell = run_query(f"""
        SELECT ts.SHIFT_START_TIME,
               REPLACE(de.STATUS, 'DWELL_', '') AS DWELL_TYPE,
               ROUND(AVG(de.DWELL_MINUTES), 1) AS AVG_DWELL,
               COUNT(*) AS SESSIONS
        FROM {SCHEMA}.DT_DWELL_ENRICHED de
        JOIN SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.TRIP_SCHEDULE ts
          ON de.TRUCK_ID = ts.TRUCK_ID
          AND DATE_TRUNC('day', de.SESSION_START)::DATE = ts.TRIP_DATE
        WHERE de.STATUS LIKE 'DWELL%' AND de.DWELL_MINUTES > 0
        GROUP BY ts.SHIFT_START_TIME, de.STATUS
        ORDER BY ts.SHIFT_START_TIME
    """)

    if len(shift_dwell) > 0:
        shift_chart = alt.Chart(shift_dwell).mark_bar().encode(
            x=alt.X('SHIFT_START_TIME:N', title='Shift start', sort=None),
            y=alt.Y('AVG_DWELL:Q', title='Avg dwell (min)'),
            color=alt.Color('DWELL_TYPE:N', scale=alt.Scale(scheme='category10')),
            xOffset='DWELL_TYPE:N',
            tooltip=['SHIFT_START_TIME:N', 'DWELL_TYPE:N', 'AVG_DWELL:Q', 'SESSIONS:Q']
        ).properties(height=350)
        st.altair_chart(shift_chart, use_container_width=True)
    else:
        st.info("No shift data available.")

st.divider()

st.subheader("Day-of-week and hour heatmap")
dow_data = run_query(f"""
    SELECT DAYOFWEEK(SESSION_START) AS DOW,
           EXTRACT(HOUR FROM SESSION_START) AS HOUR_OF_DAY,
           COUNT(*) AS SESSION_COUNT,
           ROUND(AVG(DWELL_MINUTES), 1) AS AVG_DWELL
    FROM {SCHEMA}.DT_DWELL_ENRICHED
    WHERE STATUS LIKE 'DWELL%' AND DWELL_MINUTES > 0
    GROUP BY DOW, HOUR_OF_DAY
""")

if len(dow_data) > 0:
    dow_map = {0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun'}
    dow_data['DAY_NAME'] = dow_data['DOW'].map(dow_map)

    heatmap_metric = st.segmented_control("Heatmap metric", ["SESSION_COUNT", "AVG_DWELL"], default="SESSION_COUNT")
    heatmap = alt.Chart(dow_data).mark_rect().encode(
        x=alt.X('HOUR_OF_DAY:O', title='Hour of day'),
        y=alt.Y('DAY_NAME:N', title='Day of week', sort=['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
        color=alt.Color(f'{heatmap_metric}:Q', scale=alt.Scale(scheme='blues'), title=heatmap_metric.replace('_', ' ').title()),
        tooltip=['DAY_NAME:N', 'HOUR_OF_DAY:O', 'SESSION_COUNT:Q', 'AVG_DWELL:Q']
    ).properties(height=250)
    st.altair_chart(heatmap, use_container_width=True)
