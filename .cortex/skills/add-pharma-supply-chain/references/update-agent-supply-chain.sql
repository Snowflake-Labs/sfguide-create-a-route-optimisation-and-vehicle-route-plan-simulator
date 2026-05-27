-- =============================================================================
-- update-agent-supply-chain.sql
-- Add pharma_supply_chain Cortex Analyst tool to ROUTING_AGENT
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;

-- Add the pharma_supply_chain tool to the existing ROUTING_AGENT
-- This preserves all existing tools and adds the upstream supply chain view

-- Run $setup-agent-playground to register all tools with the Routing Agent.
