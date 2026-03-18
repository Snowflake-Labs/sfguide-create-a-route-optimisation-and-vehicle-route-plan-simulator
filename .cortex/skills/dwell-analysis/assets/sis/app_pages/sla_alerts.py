import streamlit as st
import pandas as pd
import altair as alt
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("SLA breach alerts")
st.caption("Sessions exceeding configurable dwell time thresholds")

thresholds = run_query(f"SELECT * FROM {SCHEMA}.SLA_THRESHOLDS ORDER BY LOCATION_TYPE")
with st.expander("SLA threshold configuration"):
    st.dataframe(thresholds, hide_index=True)

col1, col2, col3 = st.columns(3)
with col1:
    severity = st.multiselect("Severity", ["CRITICAL", "WARNING"], default=["CRITICAL", "WARNING"])
with col2:
    status_filter = st.multiselect("Dwell type",
        ["DWELL_WAREHOUSE", "DWELL_DESTINATION", "DWELL_REST_STOP", "DWELL_STORE", "DWELL_DETOUR"],
        default=["DWELL_WAREHOUSE", "DWELL_DESTINATION", "DWELL_REST_STOP"])
with col3:
    sort_by = st.selectbox("Sort by", ["DWELL_MINUTES", "MINUTES_OVER_WARNING", "SESSION_START"])

sev_str = ",".join([f"'{s}'" for s in severity])
stat_str = ",".join([f"'{s}'" for s in status_filter])

alerts = run_query(f"""
    SELECT TRUCK_ID, STATUS, LOCATION_NAME, CITY, FACILITY_TYPE,
           SESSION_START, SESSION_END, DWELL_MINUTES, SLA_STATUS,
           WARNING_MINUTES, CRITICAL_MINUTES, MINUTES_OVER_WARNING,
           DRIVER_PROFILE, TRUCK_TYPE, HOME_BASE_NAME
    FROM {SCHEMA}.DT_SLA_ALERTS
    WHERE SLA_STATUS IN ({sev_str})
      AND STATUS IN ({stat_str})
    ORDER BY {sort_by} DESC
    LIMIT 500
""")

c1, c2, c3 = st.columns(3)
crit_cnt = len(alerts[alerts['SLA_STATUS'] == 'CRITICAL'])
warn_cnt = len(alerts[alerts['SLA_STATUS'] == 'WARNING'])
c1.metric("Showing alerts", len(alerts))
c2.metric("Critical", crit_cnt)
c3.metric("Warning", warn_cnt)

st.divider()

if len(alerts) > 0:
    col_left, col_right = st.columns([2, 1])

    with col_left:
        st.subheader("Alert details")
        st.dataframe(alerts, hide_index=True, height=500)

    with col_right:
        st.subheader("Alerts by dwell type")
        by_status = alerts.groupby('STATUS').size().reset_index(name='COUNT')
        bar = alt.Chart(by_status).mark_bar().encode(
            x='COUNT:Q',
            y=alt.Y('STATUS:N', sort='-x'),
            color='STATUS:N'
        ).properties(height=200)
        st.altair_chart(bar, use_container_width=True)

        st.subheader("Top trucks by breaches")
        by_truck = alerts.groupby('TRUCK_ID').size().reset_index(name='BREACHES').sort_values('BREACHES', ascending=False).head(10)
        truck_bar = alt.Chart(by_truck).mark_bar().encode(
            x='BREACHES:Q',
            y=alt.Y('TRUCK_ID:N', sort='-x'),
        ).properties(height=250)
        st.altair_chart(truck_bar, use_container_width=True)
else:
    st.info("No alerts matching the selected filters.")
