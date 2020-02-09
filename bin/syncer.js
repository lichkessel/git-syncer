#!/usr/bin/env node

'use strict';

const chalk = require('chalk');
const chokidar = require('chokidar');
const path = require('path');
const cp = require('child_process');
const fs = require('fs');
const fse = require('fs-extra');
const packageJson = require('../package.json');

let command;

const program = require('commander');

program.version(packageJson.version)
  .arguments('<command>')
  .usage(`${chalk.green('<command>')} [options]`)
  .action(name => {
    command = name;
  })
  .allowUnknownOption()
  .on('--help',()=>{
    console.log(chalk.green(`- Configure server: `))
    console.log(`   Run the following command in the remote repository: `);
    console.log(chalk.yellow(`    'git config --local receive.denyCurrentBranch updateInstead'`));
    console.log(`   Consider this repository as a ${chalk.red('read-only')} folder.`);
    console.log(`   ${chalk.yellow('ATENTION')}: git version should be >= 2.16.x`);
    console.log(`   ${chalk.red('WARNING')}: Do not commit or push any changes from this repository`);
    console.log(``);
    console.log(chalk.green(`- Pull changes to master as a single(squashed) commit: `));
    console.log(`   Run`);
    console.log(chalk.yellow(`    'git checkout master && git merge --squash -m "<commit message>" <gsync_branch>'`));
  })

program
  .command('start <branch> [repository-uri]')
  .description(`start watcher. Specify ${chalk.yellow('<repository-uri>')} for the first time.`)
  .action(function(branch, repositoryUri, options) {
    start(branch, repositoryUri);
  })

program.parse(process.argv);

function start(branch, repositoryUri) {
  // Preparing state
  console.log(chalk.green(`Starting gsync@${packageJson.version} for '${branch}' branch...`));
  function check(cmd) {
    try { 
      return cp.execSync(`git ${cmd}`,{stdio:['pipe','pipe','ignore']}).toString().replace(/(^\s*|\s*$)/g,'')
    } catch(e) {
      return false;
    }
  }
  let branchOrigin = `${branch}_origin`;
  let state = {
    branch : check('rev-parse --abbrev-ref HEAD'),
    dir : check('rev-parse --show-toplevel'),
    containsUncommitedChanges : check('diff --name-only HEAD'),
    repositoryUri : check(`config --get remote.${branchOrigin}.url`),
    remoteNameWhichBranchTracks : check(`config --get branch.${branch}.remote`),
    branchExists : check(`rev-parse --verify ${branch}`,{stdio:['pipe','pipe','ignore']})
  }

  // Checking state
  if(state.containsUncommitedChanges) {
    console.log(chalk.red(`The directory contains uncommited changes. Commit them and try again.`));
    process.exit(1);
  }

  // Configure remote
  console.log(chalk.yellow(`Configuring...`));
  if(repositoryUri) {
    if(state.repositoryUri) {
      console.log(chalk.yellow(`Change remote uri of '${branchOrigin}' to '${repositoryUri}'`));
      cp.execSync(`git remote set-url ${branchOrigin} ${repositoryUri}`);
    } else {
      console.log(chalk.yellow(`Set remote '${branchOrigin}' uri to '${repositoryUri}'`));
      cp.execSync(`git remote add ${branchOrigin} ${repositoryUri}`);
    }
  } else {
    if(state.repositoryUri) {
      console.log(chalk.yellow(`Remote uri of ${branchOrigin} is '${state.repositoryUri}'`));
    } else {
      console.log(chalk.red(`Remote target is not configured. Specify repository URI and run command again.`));
      process.exit(1);
    }
  }
  console.log(chalk.yellow(`Fetching changes from '${branchOrigin}' at '${state.repositoryUri || repositoryUri}'...`));
  cp.execSync(`git fetch ${branchOrigin}`);

  // Pull changes from remote

  // Checkout branch
  function rollback() {
    try {
      cp.execSync(`git checkout ${state.branch}`,{stdio:'ignore'});
      console.log(chalk.blue(`Rolled back to '${state.branch}'`));
    } catch(e) {
      console.error(e);
      console.log(chalk.red(`WARNING: could not roll back to '${state.branch}'. You have to do it manually.`))
      process.exit(1);
    }
  }

  if(!state.branchExists) { 
    try {
      cp.execSync(`git branch ${branch}`,{stdio:'ignore'});
      console.log(chalk.yellow(`Branch '${branch}' created.`))
    } catch(e) {
      console.error(e);
      console.log(chalk.red(`Error: couldn't create branch '${branch}'.`))
      process.exit(1)
    }
  }

  try {
    cp.execSync(`git branch -u ${branchOrigin}/master ${branch}`);
    console.log(chalk.yellow(`Branch '${branch}' origin set to '${branchOrigin}/master'.`))
  } catch(e) {
    console.error(e);
  }

  try {
    cp.execSync(`git checkout ${branch}`, {stdio:'ignore'}); 
    console.log(`Branch '${chalk.green(branch)}' checked out.`)
  } catch(e) {
    console.log(chalk.red(`Error: can not checkout ${branch} branch to push changes`));
    rollback();
    process.exit(1);
  }

  console.log(`Installing watcher on '${chalk.green(`${state.dir}`)}'...`);

  // Commit request
  let committing = false;
  let commitRequest;
  let firstCommit = false;
  function commit() {
    if(!committing) {
      committing = true;
      const comment = `${branch}:${new Date().toISOString()}`
      cp.execSync('git add -A');
      cp.execSync(`git commit ${firstCommit ? '' : '--amend'} -q -m "${comment}"`);
      console.log(`committed ${chalk.yellow(`${comment}`)}`);
      cp.execSync(`git push ${branchOrigin} ${branch}:master ${firstCommit ? '' : '--force'} -q`,{stdio:'ignore'});
      console.log(`pushed to ${chalk.green(`${branchOrigin}`)}`);
      committing = false;
      if(firstCommit) {
        firstCommit = false;
      }
    } else {
      if(commitRequest) {
        clearTimeout(commitRequest);
      }
      commitRequest = setTimeout(()=>{commitRequest = null; commit(); }, 200);
    }
  }

  // Watcher
  let commitJob;
  chokidar.watch('.', {
    cwd: state.dir,
    ignored: ['node_modules', '.git'],
    ignoreInitial: true
  })
  .on('all', (event, path) => {
    commit();
  })
  .on('ready', () => console.log(chalk.green('Watching... ')))
}