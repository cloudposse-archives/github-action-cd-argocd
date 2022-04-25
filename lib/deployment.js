// Usage:
//
// const deployment = require('./actions/lib/deployment.js')(actionContext)
// let pr_suffix = deployment.getInfoCI().pr_suffix // referenced in inputs.stages
// deployment.newDeployment(JSON.parse(`${{ inputs.stages }}`))
//
// Description:
//
// This class handles deployment logic and also dispatching a deployment or deployment_status event. It is meant to be used
// within a CI Composite Action whose calling GHA workflow is triggered by 'push', 'pull_request', and 'release'.
//
// 1. If the CI workflow is triggered by 'push' or 'pull_request', a deployment will be created.
// 2. In a PR, if the 'preview' label is added, a deployment will also be created.
// 3. If the 'preview' label is removed or the PR is closed, a deployment_status event will be created. the getInfoCD()
//    dictates logic which is meant to be referenced in a CD workflow, with getInfoCD().deployment_action being either
//    'create', 'delete', or '' (no action).
class Deployment {
    constructor(actionContext) {
        this.actionContext = actionContext;
    }

    getInfoCI() {
        // Event Information
        let event = this.actionContext.github.event_name
        let event_action = this.actionContext.github.event.action

        // PR Values (if applicable)
        let pull_request = this.actionContext.github.event.pull_request
        let pr_number = pull_request !== undefined ? pull_request.number : ""
        let pr_suffix = pr_number !== "" ? "-pr-" + pr_number : ""
        let pr_label = ""
        if (this.actionContext.github.event.label) {
            pr_label = this.actionContext.github.event.label.name // Only present on label / unlabeled events
        }
        let pr_closed = event === "pull_request" && event_action === "closed"

        // Git Information
        let git_ref = this.actionContext.github.head_ref !== "" ? this.actionContext.github.head_ref : this.actionContext.github.ref_name
        let git_sha = event === "pull_request" ? pull_request.head.sha : this.actionContext.github.sha

        // Preview Environment Values
        let preview_labeled = pull_request !== undefined ? pull_request.labels.some(function (element) {
            return element.name === "preview";
        }) : false
        let preview_unlabeled = event_action === "unlabeled" && pr_label === "preview"

        // CI/CD Values
        let image_build_enabled = !preview_unlabeled && !pr_closed
        let deployment_enabled  = this.actionContext.inputs.deploy === "true" && image_build_enabled

        // Deploy Action
        let deployment_action = ""
        if (pr_closed || preview_unlabeled) {
            deployment_action = "delete"
        } else if (preview_labeled || event === "push" || event === "release") {
            deployment_action = "create"
        }

        return {
            event: event,
            event_action: event_action,
            git_ref: git_ref,
            git_sha: git_sha,
            repo_name: this.actionContext.context.repo.repo,
            pr_number: pr_number,
            pr_suffix: pr_suffix,
            pr_label: pr_label,
            pr_closed: pr_closed,
            preview_labeled: preview_labeled,
            preview_unlabeled: preview_unlabeled,
            image_build_enabled: image_build_enabled,
            deployment_enabled: deployment_enabled,
            deployment_action: deployment_action,
        }
    }

    // Note that deployment_action in the context of CD is not 1-1 to the same variable in the CI context, because the GHA
    // workflow is triggered by both deployment and deployment_status.
    getInfoCD() {
        let deployment_action = ""
        if (this.actionContext.github.event_name !== 'deployment_status' && this.actionContext.github.event.deployment.payload.deploy_action === 'create') {
            deployment_action = "create"
        } else if (this.actionContext.github.event_name === 'deployment_status' && this.actionContext.github.event.deployment_status.description === 'delete') {
            deployment_action = "delete"
        }
        let commit_enabled = deployment_action !== ""

        return {
            deployment_action: deployment_action,
            commit_enabled: commit_enabled,
        }
    }

    async newDeployment(stages) {
        // Closing a PR and removing the preview label from a PR are the only events that result in `delete`
        let environments = stages[this.getInfoCI().event]

        // Trigger deployment for each environment defined in `stages`
        if (this.getInfoCI().deployment_action !== "") {
            for (var environment_key in environments) {
                let environment = environments[environment_key]
                environment.name = this.getInfoCI().pr_number !== "" ? "pr-" + this.getInfoCI().pr_number : environment_key;
                if (this.getInfoCI().deployment_action === "delete") {
                    let deployments = await this.actionContext.githubClient.rest.repos.listDeployments({
                        environment: environment.name,
                        owner: this.actionContext.context.repo.owner,
                        repo: this.actionContext.context.repo.repo,
                    })
                    let deployment = deployments.data[0]
                    if (deployment) {
                        let deployment_status = {
                            owner: this.actionContext.context.repo.owner,
                            repo: this.actionContext.context.repo.repo,
                            deployment_id: deployment.id,
                            state: "in_progress",
                            description: this.getInfoCI().deployment_action,
                        }
                        console.log("deployment_status: ", deployment_status)
                        // https://octokit.github.io/rest.js/v18#repos-create-deployment-status
                        this.actionContext.githubClient.rest.repos.createDeploymentStatus(deployment_status)
                    }
                } else if (this.getInfoCI().deployment_action === "create") {
                    let deployment_event = {
                        owner: this.actionContext.context.repo.owner,
                        repo: this.actionContext.context.repo.repo,
                        auto_merge: false,
                        ref: this.getInfoCI().pr_closed ? this.actionContext.github.base_ref : this.getInfoCI().git_ref,
                        required_contexts: [],
                        environment: environment.name,
                        environment_url: environment.environment_url,
                        log_url: environment.log_url,
                        payload: {
                            app: this.actionContext.context.repo.repo + this.getInfoCI().pr_suffix,
                            argocd_repo: environment.repo,
                            environment: environment_key,
                            namespace: environment.namespace,
                            deploy_action: this.getInfoCI().deployment_action,
                            image: this.actionContext.steps.vars.outputs.image_tag_sha,
                            environment_url: environment.environment_url,
                            service_url: environment.service_url,
                            app_repository: this.actionContext.github.repository,
                            app_commit: this.getInfoCI().git_sha
                        }
                    }
                    console.log(deployment_event)
                    // https://octokit.github.io/rest.js/v18#repos-create-deployment
                    this.actionContext.githubClient.rest.repos.createDeployment(deployment_event)
                }
            }
        }
    }
}

module.exports = function (actionContext) {
    return new Deployment(actionContext)
}
