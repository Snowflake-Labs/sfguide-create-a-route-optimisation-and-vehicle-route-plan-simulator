import streamlit as st
import json
import time
from snowflake.snowpark.context import get_active_session
from datetime import datetime

session = get_active_session()
app_name = session.sql("SELECT CURRENT_DATABASE()").collect()[0][0]

st.set_page_config(
    page_title="Fleet Intelligence",
    page_icon="🚚",
    layout="wide",
    initial_sidebar_state="collapsed"
)

SB_ORANGE = "#FF6B35"
SB_DARK_ORANGE = "#CC5528"
SB_CHARCOAL = "#333333"
SB_WHITE = "#FFFFFF"
SB_LIGHT_GRAY = "#F5F5F5"
SB_MID_GRAY = "#8A999E"

st.markdown(f"""
<style>
    @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700;900&display=swap');

    .stApp {{
        font-family: 'Source Sans 3', -apple-system, BlinkMacSystemFont, sans-serif;
    }}

    .gradient-header {{
        background: linear-gradient(135deg, {SB_CHARCOAL} 0%, #1D1D1B 100%);
        margin: -6rem -4rem 2rem -4rem;
        padding: 1.5rem 4rem;
    }}

    .header-content {{
        display: flex;
        align-items: center;
        gap: 1rem;
    }}

    .logo-container {{
        background: rgba(255,107,53,0.15);
        padding: 0.75rem;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
    }}

    .header-title {{
        color: white;
        font-size: 1.75rem;
        font-weight: 700;
        margin: 0;
        letter-spacing: -0.5px;
    }}

    .header-subtitle {{
        color: {SB_ORANGE};
        font-size: 0.85rem;
        margin: 0;
        font-weight: 400;
    }}

    .status-badge {{
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        background: {SB_ORANGE};
        color: white;
        padding: 0.5rem 1rem;
        border-radius: 20px;
        font-size: 0.8rem;
        font-weight: 700;
        margin-left: auto;
    }}

    .status-badge.ready {{
        background: #10b981;
        color: white;
    }}

    .status-badge.starting {{
        background: #f59e0b;
        color: white;
    }}

    .status-badge.error {{
        background: #ef4444;
        color: white;
    }}

    .status-dot {{
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: white;
    }}

    .section-header {{
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 1.25rem;
        font-weight: 700;
        color: {SB_CHARCOAL};
        margin: 2.5rem 0 1.25rem 0;
        padding-bottom: 0.75rem;
        border-bottom: 3px solid {SB_ORANGE};
    }}

    .section-icon {{
        background: linear-gradient(135deg, {SB_ORANGE} 0%, {SB_DARK_ORANGE} 100%);
        color: white;
        width: 36px;
        height: 36px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.1rem;
    }}

    .launch-card {{
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        padding: 1.5rem;
        transition: all 0.2s ease;
    }}

    .launch-card:hover {{
        box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }}

    .launch-card-title {{
        font-size: 1rem;
        font-weight: 700;
        color: {SB_CHARCOAL};
        margin-bottom: 0.75rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }}

    .feature-card {{
        background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
        border-radius: 12px;
        padding: 1rem;
        border: 1px solid #e2e8f0;
        text-align: center;
    }}

    .feature-icon {{
        font-size: 1.5rem;
        margin-bottom: 0.5rem;
    }}

    .feature-title {{
        font-weight: 700;
        color: {SB_CHARCOAL};
        font-size: 0.85rem;
        margin-bottom: 0.25rem;
    }}

    .feature-desc {{
        font-size: 0.75rem;
        color: {SB_MID_GRAY};
    }}

    .info-table {{
        width: 100%;
        border-collapse: collapse;
        background: white;
        border-radius: 12px;
        overflow: hidden;
    }}

    .info-table td {{
        padding: 1rem;
        border-bottom: 1px solid #f1f5f9;
    }}

    .info-table tr:last-child td {{
        border-bottom: none;
    }}

    .info-table td:first-child {{
        font-weight: 700;
        color: {SB_MID_GRAY};
        width: 40%;
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }}

    .info-table td:last-child {{
        color: {SB_CHARCOAL};
        font-weight: 500;
    }}

    .footer {{
        text-align: center;
        color: {SB_MID_GRAY};
        font-size: 0.8rem;
        padding: 2rem 0;
        margin-top: 3rem;
        border-top: 1px solid #e2e8f0;
    }}

    div[data-testid="stExpander"] {{
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        margin-bottom: 0.75rem;
        overflow: hidden;
    }}

    div[data-testid="stExpander"]:hover {{
        border-color: {SB_ORANGE};
        box-shadow: 0 2px 8px rgba(255,107,53,0.1);
    }}
</style>
""", unsafe_allow_html=True)

TRUCK_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512" width="32" height="32" fill="#FF6B35">
  <path d="M48 0C21.5 0 0 21.5 0 48V368c0 26.5 21.5 48 48 48H64c0 53 43 96 96 96s96-43 96-96H384c0 53 43 96 96 96s96-43 96-96h32c17.7 0 32-14.3 32-32s-14.3-32-32-32V288 256 237.3c0-17-6.7-33.3-18.7-45.3L512 114.7c-12-12-28.3-18.7-45.3-18.7H416V48c0-26.5-21.5-48-48-48H48zM416 160h50.7L544 237.3V256H416V160zM160 464a48 48 0 1 1 0-96 48 48 0 1 1 0 96zm368-48a48 48 0 1 1 -96 0 48 48 0 1 1 96 0z"/>
</svg>"""

try:
    account_info = session.sql("SELECT CURRENT_ORGANIZATION_NAME(), CURRENT_ACCOUNT_NAME()").collect()
    org_name = account_info[0][0] if account_info else "unknown"
    account_name = account_info[0][1] if account_info else "unknown"
except Exception:
    org_name = "unknown"
    account_name = "unknown"

try:
    row = session.sql("CALL core.get_status()").collect()
    result = json.loads(row[0][0]) if row else {}

    svc_status = result.get("service_status", "UNKNOWN")
    endpoint_url = result.get("endpoint_url", "")

    if svc_status in ("READY", "RUNNING"):
        badge_class = "ready"
        badge_text = "Ready"
    elif svc_status in ("STARTING", "PENDING"):
        badge_class = "starting"
        badge_text = "Starting up..."
    else:
        badge_class = "error"
        badge_text = "Not Available"

    st.markdown(f"""
    <div class="gradient-header">
        <div class="header-content">
            <div class="logo-container">{TRUCK_SVG}</div>
            <div>
                <h1 class="header-title">SwiftBite Fleet Intelligence</h1>
                <p class="header-subtitle">Powered by Snowflake Cortex AI</p>
            </div>
            <div class="status-badge {badge_class}">
                <span class="status-dot"></span>
                {badge_text}
            </div>
        </div>
    </div>
    """, unsafe_allow_html=True)

    st.markdown(f"""
    <div class="section-header">
        <div class="section-icon">🚀</div>
        Get Started
    </div>
    """, unsafe_allow_html=True)

    url_is_valid = endpoint_url and ".snowflakecomputing.app" in endpoint_url
    service_ready = svc_status in ("READY", "RUNNING") and url_is_valid

    if service_ready:
        app_url = f"https://{endpoint_url}"

        col1, col2 = st.columns(2)
        with col1:
            st.markdown(f"""
            <div class="launch-card">
                <div class="launch-card-title">🗺️ Fleet Map Application</div>
                <p style="color: {SB_MID_GRAY}; font-size: 0.85rem; margin-bottom: 1rem;">Explore delivery routes, courier activity heatmaps, and fleet performance across 20 California cities with AI-powered analysis.</p>
            </div>
            """, unsafe_allow_html=True)
            st.link_button("Launch Fleet Map", app_url, type="primary", use_container_width=True)
        with col2:
            st.markdown(f"""
            <div class="launch-card">
                <div class="launch-card-title">🤖 Fleet Intelligence Agent</div>
                <p style="color: {SB_MID_GRAY}; font-size: 0.85rem; margin-bottom: 1rem;">Ask natural language questions about delivery performance, courier efficiency, restaurant volumes, and route optimization.</p>
            </div>
            """, unsafe_allow_html=True)
            st.link_button("Chat in App", app_url, type="secondary", use_container_width=True)
    else:
        st.markdown(f"""
        <div class="launch-card">
            <div class="launch-card-title">⏳ Please Wait</div>
            <p style="color: {SB_MID_GRAY}; font-size: 0.85rem; margin-bottom: 0.5rem;">Fleet Intelligence is starting up — this usually takes a couple of minutes. This page will refresh automatically.</p>
        </div>
        """, unsafe_allow_html=True)
        st.info("Checking service status...")
        if svc_status in ("NOT_FOUND", "UNKNOWN"):
            session.sql("CALL core.deploy()").collect()
        time.sleep(10)
        st.rerun()

    st.markdown(f"""
    <div class="section-header">
        <div class="section-icon">✨</div>
        What's Included
    </div>
    """, unsafe_allow_html=True)

    f1, f2, f3, f4 = st.columns(4)
    with f1:
        st.markdown("""
        <div class="feature-card">
            <div class="feature-icon">🗺️</div>
            <div class="feature-title">Route Visualization</div>
            <div class="feature-desc">Delivery paths across 20 cities</div>
        </div>
        """, unsafe_allow_html=True)
    with f2:
        st.markdown("""
        <div class="feature-card">
            <div class="feature-icon">🔥</div>
            <div class="feature-title">Activity Heatmap</div>
            <div class="feature-desc">H3 hexagonal courier density</div>
        </div>
        """, unsafe_allow_html=True)
    with f3:
        st.markdown("""
        <div class="feature-card">
            <div class="feature-icon">🤖</div>
            <div class="feature-title">Cortex AI Agent</div>
            <div class="feature-desc">Natural language fleet queries</div>
        </div>
        """, unsafe_allow_html=True)
    with f4:
        st.markdown("""
        <div class="feature-card">
            <div class="feature-icon">📊</div>
            <div class="feature-title">Fleet Analytics</div>
            <div class="feature-desc">City-level performance stats</div>
        </div>
        """, unsafe_allow_html=True)

    with st.expander("Service Details"):
        svc_display = "Running" if svc_status in ("READY", "RUNNING") else ("Starting" if svc_status in ("STARTING", "PENDING") else "Offline")
        st.markdown(f"""
        <table class="info-table">
            <tr><td>Status</td><td>{svc_display}</td></tr>
            <tr><td>Endpoint</td><td>{"Live" if url_is_valid else "Pending"}</td></tr>
            <tr><td>Data Source</td><td>SwiftBite Food Delivery</td></tr>
            <tr><td>Coverage</td><td>20 California Cities</td></tr>
            <tr><td>Resolution</td><td>H3 Level 9</td></tr>
            <tr><td>Application</td><td>{app_name}</td></tr>
            <tr><td>Account</td><td>{org_name}/{account_name}</td></tr>
        </table>
        """, unsafe_allow_html=True)

    st.markdown(f"""
    <div class="footer">
        <strong style="color: {SB_ORANGE};">SwiftBite Fleet Intelligence</strong><br/>
        Snowflake Intelligence | {org_name}/{account_name}<br/>
        {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    </div>
    """, unsafe_allow_html=True)

except Exception as e:
    st.markdown(f"""
    <div class="gradient-header">
        <div class="header-content">
            <div class="logo-container">{TRUCK_SVG}</div>
            <div>
                <h1 class="header-title">SwiftBite Fleet Intelligence</h1>
                <p class="header-subtitle">Powered by Snowflake Cortex AI</p>
            </div>
            <div class="status-badge error">
                <span class="status-dot"></span>
                Not Available
            </div>
        </div>
    </div>
    """, unsafe_allow_html=True)
    st.error(f"Something went wrong: {e}")
    st.info("The service may still be starting up. Please wait a couple of minutes and refresh the page.")
