variable "application_name" {
  type = string
}

variable "primary_region" {
  type = string
}

variable "public_key" {
  type = string
}

variable "subscription_id" {
  type        = string
  description = "Azure subscription ID"
}

variable "environment" {
  description = "The environment name (test or prod)"
  type        = string
}

variable "vm_size" {
  description = "The size of the virtual machine"
  type        = string
}

variable "vm_count" {
  description = "Number of VMs to deploy"
  type        = number
  default     = 1
}

variable "db_admin_password" {
  description = "The password for the PostgreSQL administrator"
  type        = string
  sensitive   = true
}

variable "copernicus_client_id" {
  description = "The client ID for the Copernicus API"
  type        = string
}

variable "copernicus_client_secret" {
  description = "The client secret for the Copernicus API"
  type        = string
  sensitive   = true
}
