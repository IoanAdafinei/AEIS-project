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
