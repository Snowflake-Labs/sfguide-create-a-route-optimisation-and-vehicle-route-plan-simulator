"""
Basic example of a Mkdocs-macros module
"""

from os import environ, getcwd, path as os_path
import uuid
import base64
import urllib.parse

from mkdocs_macros.plugin import MacrosPlugin


def flatten_html(html):
    """Take the HTML and flatten it to one line"""
    html = html.replace("\n", "")
    html = html.replace("\r", "")
    html = html.replace("\t", "")
    return html


def create_dde_env(variables_to_encode={}) -> str:
    """
    Create a base64 encoded string of the supplied dictionary.
    """
    dde_env = ""
    for key, value in variables_to_encode.items():
        dde_env += f"{key}={value}\n"
    dde_env = base64.b64encode(dde_env.encode("utf-8"))
    dde_env = urllib.parse.quote_plus(dde_env.decode("utf-8"))
    return dde_env


def define_env(env: MacrosPlugin):
    """
    This is the hook for defining variables, macros and filters

    - variables: the dictionary that contains the environment variables
    - macro: a decorator function, to declare a macro.
    - filter: a function with one of more arguments,
        used to perform a transformation
    """

    for name, value in environ.items():
        if (
            name.startswith("FROSTBYTE_")
            or name.startswith("CI_")
            or name.startswith("DATAOPS_")
            or name.startswith("GITLAB_")
            or name.startswith("EVENT_")
        ):
            env.variables[name] = value

    def _get_dde_parts(pass_variables=[]):
        url = "https://develop.dataops.live/quickstart?autostart=true#"
        if env.variables.get("DATAOPS_CATALOG_DEVREADY_URL"):
            url = env.variables.DATAOPS_CATALOG_DEVREADY_URL
        ci_project_url = ""
        if env.variables.get("CI_PROJECT_URL"):
            ci_project_url = env.variables.CI_PROJECT_URL
        ci_build_ref_name = "main"
        if env.variables.get("CI_BUILD_REF_NAME"):
            ci_build_ref_name = env.variables.CI_BUILD_REF_NAME
        random_id = uuid.uuid1()

        """Add env vars needed in the DDE (paired with the autorun.sh script)"""
        default_variables = {"DATAOPS_MODE": "SSC"}

        for variable in pass_variables:
            default_variables[variable] = env.variables.get(variable)
        dde_env = create_dde_env(default_variables)
        return url, ci_project_url, ci_build_ref_name, random_id, dde_env

    @env.macro
    def dde_url(path="", pass_variables=[]) -> str:
        url, ci_project_url, ci_build_ref_name, _, dde_env = _get_dde_parts(
            pass_variables
        )
        return (
            f"{url}DDE_ENV={dde_env}/{ci_project_url}/-/tree/{ci_build_ref_name}/{path}"
        )

    @env.macro
    def continue_block(img="", loom_id=""):
        """Load a html from a file"""
        html = ""
        cwd = getcwd()
        filepath = os_path.join(
            cwd,
            "html/continue_block.html",
        )

        with open(filepath, "r") as f:
            html = f.read()
        html = html.replace("{img}", img)
        html = html.replace("{loom_id}", loom_id)

        return flatten_html(html)
        
    @env.macro
    def dde_button(path="", align="center", pass_variables=[]):
        url, ci_project_url, ci_build_ref_name, random_id, dde_env = _get_dde_parts(
            pass_variables
        )

        """Load a html button from a file"""
        html = ""
        cwd = getcwd()
        filepath = os_path.join(
            cwd,
            "html/dde_button.html",
        )

        with open(filepath, "r") as f:
            html = f.read()
        html = html.replace("{url}", url)
        html = html.replace("{dde_env}", dde_env)
        html = html.replace("{path}", path)
        html = html.replace("{align}", align)
        html = html.replace("{ci_project_url}", ci_project_url)
        html = html.replace("{ci_build_ref_name}", ci_build_ref_name)
        html = html.replace("{random_id}", str(random_id))

        return flatten_html(html)

    @env.macro
    def build_badge():
        if not env.variables.get("FROSTBYTE_CUSTOMER_NAME") or not env.variables.get(
            "FROSTBYTE_SOLUTION_TEMPLATE_NAME"
        ):
            return ""

        customer_name = env.variables.FROSTBYTE_CUSTOMER_NAME
        solution_template_name = env.variables.FROSTBYTE_SOLUTION_TEMPLATE_NAME

        """Load a html from a file"""
        html = ""
        cwd = getcwd()
        filepath = os_path.join(
            cwd,
            "html/build_badge.html",
        )

        with open(filepath, "r") as f:
            html = f.read()
        html = html.replace("{customer_name}", customer_name)
        html = html.replace("{solution_template_name}", solution_template_name)

        return flatten_html(html)

    @env.macro
    def customer_logo(width="auto", height="2rem"):
        if not env.variables.get("FROSTBYTE_CUSTOMER_LOGO_URL"):
            env.variables["FROSTBYTE_CUSTOMER_LOGO_URL"] = (
                "data:image/png;base64,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"
            )

        customer_logo_url = env.variables.FROSTBYTE_CUSTOMER_LOGO_URL

        """Load a html from a file"""
        html = ""
        cwd = getcwd()
        filepath = os_path.join(
            cwd,
            "html/customer_logo.html",
        )

        with open(filepath, "r") as f:
            html = f.read()
        html = html.replace("{customer_logo_url}", customer_logo_url)
        html = html.replace("{width}", width)
        html = html.replace("{height}", height)

        return flatten_html(html)

    @env.macro
    def snowsight_button(title="Open Snowsight"):
        if not env.variables.get("DATAOPS_SOLE_ACCOUNT"):
            env.variables["DATAOPS_SOLE_ACCOUNT"] = "app"

        dataops_sole_account = env.variables.DATAOPS_SOLE_ACCOUNT

        """Load a html from a file"""
        html = ""
        cwd = getcwd()
        filepath = os_path.join(
            cwd,
            "html/snowsight_button.html",
        )

        with open(filepath, "r") as f:
            html = f.read()
        html = html.replace("{title}", title)
        html = html.replace("{dataops_sole_account}", dataops_sole_account)

        return flatten_html(html)

    @env.macro
    def getenv(variable, default=""):
        return environ.get(variable, default)

    @env.macro
    def env_var(variable, default=""):
        return environ.get(variable, default)

    @env.macro
    def include_raw(filename, start_line=0, end_line=None):
        """
        Include a file, optionally indicating start_line and end_line
        (start counting from 0)
        The path is relative to the top directory of the documentation
        project.
        """
        full_filename = os_path.join(env.project_dir, filename)
        with open(full_filename, "r") as f:
            lines = f.readlines()
        line_range = lines[start_line:end_line]
        return "".join(line_range)
