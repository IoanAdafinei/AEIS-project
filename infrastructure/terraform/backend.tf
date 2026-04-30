terraform {
  backend "azurerm" {
    resource_group_name  = "aeis-remote-terraform-state"
    storage_account_name = "terraformremotestate3189"
    container_name       = "tfstate"
    key                  = "satellite-project.tfstate"
  }
}
