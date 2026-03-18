-- Optional: set your role/warehouse if needed
-- use role <YOUR_ROLE>;
-- use warehouse <YOUR_WAREHOUSE>;

-- Create and select a workspace
create database if not exists UK_STORMS_DB;
use database UK_STORMS_DB;
create schema if not exists PUBLIC;
use schema PUBLIC;

-- Robust CSV file format for quoted, UTF-8, long-text fields
create or replace file format CSV_UK_STORMS
  type = csv
  field_delimiter = ','
  skip_header = 1
  field_optionally_enclosed_by = '"'
  encoding = 'UTF8'
  null_if = ('\\N','NULL')
  empty_field_as_null = false
  trim_space = false
  error_on_column_count_mismatch = true
  replace_invalid_characters = true
  multi_line = true;

-- Target table (store all fields as TEXT for flexibility)
create or replace table UK_STORMS (
  NAME string,
  DATES string,
  DESCRIPTION string,
  UK_FATALITIES string,
  SOURCE string,
  NEWS_SUMMARY string
);

-- Use the table stage for simple loading
-- Upload the CSV from your local machine to the table stage
put file:///Users/boconnor/uk_storms/uk_storms.csv @%UK_STORMS auto_compress=false;

-- Load into the table
copy into UK_STORMS
  from @%UK_STORMS
  files = ('uk_storms.csv')
  file_format = (format_name = CSV_UK_STORMS)
  on_error = 'abort_statement'
  force = true;

-- Quick verification
-- select count(*) as row_count from UK_STORMS;
-- select * from UK_STORMS limit 5;
