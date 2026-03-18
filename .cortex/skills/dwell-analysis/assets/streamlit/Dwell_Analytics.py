import streamlit as st
import pandas as pd
import altair as alt
import os
import snowflake.connector

st.set_page_config(page_title="Dwell & Congestion Analytics", layout="wide", initial_sidebar_state="expanded")

SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_resource
def get_connection():
    return snowflake.connector.connect(
        connection_name=os.getenv("SNOWFLAKE_CONNECTION_NAME")
    )

def run_query(sql):
    conn = get_connection()
    return pd.read_sql(sql, conn)

st.title("Dwell & Congestion Analytics")
st.caption("Real-Time Vehicle State Change Detection and Dwell Monitoring")

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

c1, c2, c3, c4, c5 = st.columns(5)
c1.metric("Active Vehicles", f"{drivers['TOTAL_DRIVERS'].iloc[0]:,}")
c2.metric("Total Dwell Hours", f"{drivers['FLEET_DWELL_HOURS'].iloc[0]:,.0f}")
c3.metric("Avg Session (min)", f"{drivers['AVG_SESSION'].iloc[0]:.1f}")

critical = alerts.loc[alerts['SLA_STATUS'] == 'CRITICAL', 'CNT'].sum()
warning = alerts.loc[alerts['SLA_STATUS'] == 'WARNING', 'CNT'].sum()
c4.metric("Critical Alerts", f"{critical:,}", delta=None)
c5.metric("Warning Alerts", f"{warning:,}", delta=None)

st.divider()

col_left, col_right = st.columns(2)

with col_left:
    st.subheader("Daily Dwell Hours")
    chart = alt.Chart(trends).mark_bar().encode(
        x=alt.X('TREND_DATE:T', title='Date'),
        y=alt.Y('TOTAL_DWELL_HOURS:Q', title='Dwell Hours'),
        tooltip=['TREND_DATE:T', 'TOTAL_DWELL_HOURS:Q', 'ACTIVE_VEHICLES:Q']
    ).properties(height=350)
    st.altair_chart(chart, use_container_width=True)

with col_right:
    st.subheader("Dwell Distribution by Type")
    dwell_cols = ['WAREHOUSE_DWELL_MIN', 'DESTINATION_DWELL_MIN', 'REST_STOP_DWELL_MIN', 'STORE_DWELL_MIN']
    totals = trends[dwell_cols].sum()
    dist_df = pd.DataFrame({
        'Type': ['Warehouse', 'Destination', 'Rest Stop', 'Store'],
        'Minutes': totals.values
    })
    pie = alt.Chart(dist_df).mark_arc(innerRadius=50).encode(
        theta=alt.Theta('Minutes:Q'),
        color=alt.Color('Type:N', scale=alt.Scale(scheme='tableau10')),
        tooltip=['Type:N', 'Minutes:Q']
    ).properties(height=350)
    st.altair_chart(pie, use_container_width=True)

st.subheader("Daily Trend Details")
st.dataframe(trends, use_container_width=True, hide_index=True)
