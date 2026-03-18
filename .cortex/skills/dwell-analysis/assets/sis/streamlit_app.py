import streamlit as st
import pandas as pd
import altair as alt
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Dwell & Congestion Analytics")
st.caption("Real-time vehicle state change detection and dwell monitoring")

trends = run_query(f"""
    SELECT TREND_DATE, TOTAL_SESSIONS, ACTIVE_VEHICLES, TOTAL_DWELL_HOURS,
           AVG_SESSION_MIN, WAREHOUSE_DWELL_MIN, DESTINATION_DWELL_MIN,
           REST_STOP_DWELL_MIN, STORE_DWELL_MIN, UNIQUE_H3_CELLS
    FROM {SCHEMA}.DT_DAILY_TRENDS ORDER BY TREND_DATE
""")

alerts = run_query(f"""
    SELECT SLA_STATUS, COUNT(*) AS CNT FROM {SCHEMA}.DT_SLA_ALERTS GROUP BY SLA_STATUS
""")

drivers = run_query(f"""
    SELECT COUNT(*) AS TOTAL_DRIVERS,
           SUM(TOTAL_DWELL_HOURS) AS FLEET_DWELL_HOURS,
           ROUND(AVG(AVG_SESSION_MIN), 1) AS AVG_SESSION,
           SUM(SLA_BREACH_COUNT) AS TOTAL_BREACHES
    FROM {SCHEMA}.DT_DRIVER_DWELL_SUMMARY
""")

percentiles = run_query(f"""
    SELECT ROUND(APPROX_PERCENTILE(DWELL_MINUTES, 0.5), 1) AS P50_MIN,
           ROUND(APPROX_PERCENTILE(DWELL_MINUTES, 0.95), 1) AS P95_MIN
    FROM {SCHEMA}.DT_DWELL_ENRICHED
    WHERE STATUS LIKE 'DWELL%' AND DWELL_MINUTES > 0
""")

c1, c2, c3, c4, c5, c6, c7 = st.columns(7)
c1.metric("Active vehicles", f"{drivers['TOTAL_DRIVERS'].iloc[0]:,}")
c2.metric("Total dwell hours", f"{drivers['FLEET_DWELL_HOURS'].iloc[0]:,.0f}")
c3.metric("Avg session (min)", f"{drivers['AVG_SESSION'].iloc[0]:.1f}")
c4.metric("p50 dwell (min)", f"{percentiles['P50_MIN'].iloc[0]:.1f}")
c5.metric("p95 dwell (min)", f"{percentiles['P95_MIN'].iloc[0]:.1f}")

critical = alerts.loc[alerts['SLA_STATUS'] == 'CRITICAL', 'CNT'].sum()
warning = alerts.loc[alerts['SLA_STATUS'] == 'WARNING', 'CNT'].sum()
c6.metric("Critical alerts", f"{critical:,}")
c7.metric("Warning alerts", f"{warning:,}")

st.divider()

col_left, col_right = st.columns(2)

with col_left:
    st.subheader("Daily dwell hours by type")
    melted = trends.melt(
        id_vars=['TREND_DATE'],
        value_vars=['WAREHOUSE_DWELL_MIN', 'DESTINATION_DWELL_MIN', 'REST_STOP_DWELL_MIN', 'STORE_DWELL_MIN'],
        var_name='TYPE', value_name='MINUTES'
    )
    melted['TYPE'] = melted['TYPE'].str.replace('_DWELL_MIN', '').str.replace('_', ' ').str.title()
    melted['HOURS'] = melted['MINUTES'] / 60.0
    stacked = alt.Chart(melted).mark_bar().encode(
        x=alt.X('TREND_DATE:T', title='Date'),
        y=alt.Y('HOURS:Q', title='Dwell hours', stack='zero'),
        color=alt.Color('TYPE:N', scale=alt.Scale(scheme='tableau10'), title='Dwell type'),
        tooltip=['TREND_DATE:T', 'TYPE:N', alt.Tooltip('HOURS:Q', format='.1f')]
    ).properties(height=350)
    st.altair_chart(stacked, use_container_width=True)

with col_right:
    st.subheader("Dwell distribution by type")
    dwell_cols = ['WAREHOUSE_DWELL_MIN', 'DESTINATION_DWELL_MIN', 'REST_STOP_DWELL_MIN', 'STORE_DWELL_MIN']
    totals = trends[dwell_cols].sum()
    dist_df = pd.DataFrame({
        'Type': ['Warehouse', 'Destination', 'Rest stop', 'Store'],
        'Minutes': totals.values
    })
    pie = alt.Chart(dist_df).mark_arc(innerRadius=50).encode(
        theta=alt.Theta('Minutes:Q'),
        color=alt.Color('Type:N', scale=alt.Scale(scheme='tableau10')),
        tooltip=['Type:N', alt.Tooltip('Minutes:Q', format=',.0f')]
    ).properties(height=350)
    st.altair_chart(pie, use_container_width=True)

st.divider()

st.subheader("Top facilities by average dwell time")
top_facilities = run_query(f"""
    SELECT LOCATION_NAME, LOC_TYPE, ROUND(AVG(AVG_DWELL_MIN), 1) AS AVG_DWELL_MIN,
           SUM(TOTAL_SESSIONS) AS TOTAL_SESSIONS, SUM(UNIQUE_VEHICLES) AS UNIQUE_VEHICLES
    FROM {SCHEMA}.DT_FACILITY_UTILIZATION
    GROUP BY LOCATION_NAME, LOC_TYPE
    ORDER BY AVG_DWELL_MIN DESC
    LIMIT 10
""")

if len(top_facilities) > 0:
    fbar = alt.Chart(top_facilities).mark_bar().encode(
        x=alt.X('AVG_DWELL_MIN:Q', title='Avg dwell (min)'),
        y=alt.Y('LOCATION_NAME:N', sort='-x', title='Facility'),
        color=alt.Color('LOC_TYPE:N', scale=alt.Scale(scheme='category10')),
        tooltip=['LOCATION_NAME:N', 'LOC_TYPE:N', 'AVG_DWELL_MIN:Q', 'TOTAL_SESSIONS:Q', 'UNIQUE_VEHICLES:Q']
    ).properties(height=300)
    st.altair_chart(fbar, use_container_width=True)

st.subheader("Daily trend details")
st.dataframe(trends)
