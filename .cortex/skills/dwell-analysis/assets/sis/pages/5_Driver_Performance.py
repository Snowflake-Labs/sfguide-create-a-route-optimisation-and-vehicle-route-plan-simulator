import streamlit as st
import pandas as pd
import altair as alt
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Driver performance")
st.caption("Fleet-wide dwell rankings by driver and vehicle")

data = run_query(f"""
    SELECT TRUCK_ID, DRIVER_PROFILE, TRUCK_TYPE, HOME_BASE_NAME,
           TOTAL_DWELL_SESSIONS, TOTAL_DWELL_HOURS, AVG_SESSION_MIN,
           UNIQUE_LOCATIONS, SLA_BREACH_COUNT, CRITICAL_BREACH_COUNT
    FROM {SCHEMA}.DT_DRIVER_DWELL_SUMMARY
    ORDER BY TOTAL_DWELL_HOURS DESC
""")

c1, c2, c3, c4 = st.columns(4)
c1.metric("Fleet size", f"{len(data):,}")
c2.metric("Fleet avg session (min)", f"{data['AVG_SESSION_MIN'].mean():.1f}")
c3.metric("Total SLA breaches", f"{data['SLA_BREACH_COUNT'].sum():,}")
c4.metric("Total critical breaches", f"{data['CRITICAL_BREACH_COUNT'].sum():,}")

st.divider()

col_left, col_right = st.columns(2)

with col_left:
    st.subheader("Driver profile breakdown")
    profile_agg = data.groupby('DRIVER_PROFILE').agg(
        TRUCKS=('TRUCK_ID', 'count'),
        AVG_DWELL_HOURS=('TOTAL_DWELL_HOURS', 'mean'),
        AVG_SESSION_MIN=('AVG_SESSION_MIN', 'mean'),
        BREACH_RATE=('SLA_BREACH_COUNT', 'mean'),
    ).reset_index()
    profile_agg = profile_agg.round(1)

    base = alt.Chart(profile_agg).encode(
        x=alt.X('DRIVER_PROFILE:N', title='Driver profile', sort=['COMPLIANT', 'MILD', 'OUTLIER']),
    )
    bars = base.mark_bar().encode(
        y=alt.Y('AVG_SESSION_MIN:Q', title='Avg session (min)'),
        tooltip=['DRIVER_PROFILE:N', 'TRUCKS:Q', 'AVG_SESSION_MIN:Q', 'BREACH_RATE:Q']
    )
    text = base.mark_text(dy=-8).encode(
        y='AVG_SESSION_MIN:Q',
        text=alt.Text('AVG_SESSION_MIN:Q', format='.1f')
    )
    st.altair_chart((bars + text).properties(height=300), use_container_width=True)

    st.caption("Avg SLA breach rate per truck by profile")
    breach_bars = alt.Chart(profile_agg).mark_bar().encode(
        x=alt.X('DRIVER_PROFILE:N', title='Driver profile', sort=['COMPLIANT', 'MILD', 'OUTLIER']),
        y=alt.Y('BREACH_RATE:Q', title='Avg breaches per truck'),
        tooltip=['DRIVER_PROFILE:N', 'BREACH_RATE:Q']
    ).properties(height=250)
    st.altair_chart(breach_bars, use_container_width=True)

with col_right:
    st.subheader("Top 10 trucks by critical breaches")
    top_breach = data.nlargest(10, 'CRITICAL_BREACH_COUNT')
    hbar = alt.Chart(top_breach).mark_bar().encode(
        x=alt.X('CRITICAL_BREACH_COUNT:Q', title='Critical breaches'),
        y=alt.Y('TRUCK_ID:N', sort='-x', title='Truck'),
        color=alt.Color('DRIVER_PROFILE:N', scale=alt.Scale(scheme='category10')),
        tooltip=['TRUCK_ID:N', 'DRIVER_PROFILE:N', 'CRITICAL_BREACH_COUNT:Q',
                 'SLA_BREACH_COUNT:Q', 'TOTAL_DWELL_HOURS:Q']
    ).properties(height=300)
    st.altair_chart(hbar, use_container_width=True)

    st.subheader("Top 10 trucks by total dwell hours")
    top_dwell = data.nlargest(10, 'TOTAL_DWELL_HOURS')
    hbar2 = alt.Chart(top_dwell).mark_bar().encode(
        x=alt.X('TOTAL_DWELL_HOURS:Q', title='Total dwell hours'),
        y=alt.Y('TRUCK_ID:N', sort='-x', title='Truck'),
        color=alt.Color('DRIVER_PROFILE:N', scale=alt.Scale(scheme='category10')),
        tooltip=['TRUCK_ID:N', 'DRIVER_PROFILE:N', 'TOTAL_DWELL_HOURS:Q', 'AVG_SESSION_MIN:Q']
    ).properties(height=300)
    st.altair_chart(hbar2, use_container_width=True)

st.divider()
st.subheader("Full fleet rankings")
sort_col = st.selectbox("Sort by", ['TOTAL_DWELL_HOURS', 'AVG_SESSION_MIN', 'SLA_BREACH_COUNT', 'CRITICAL_BREACH_COUNT'], index=0)
st.dataframe(data.sort_values(sort_col, ascending=False), height=400)
